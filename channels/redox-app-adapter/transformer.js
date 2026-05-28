/**
 * Redox App Adapter — Inbound + Outbound
 *
 * Inbound:  HTTP Listener receives a Redox JSON envelope, validates the
 *           X-Verification-Token header (HMAC-SHA256 over the raw body
 *           with the channel's shared secret), maps the Redox DataModel
 *           + EventType to a FHIR Bundle, hands off downstream.
 *
 * Outbound: Build a Redox envelope from internal records and POST to
 *           Redox via HTTP Sender. Standard Redox auth header is added.
 *
 * Redox envelope (simplified):
 *   {
 *     "Meta": {
 *       "DataModel": "PatientAdmin",
 *       "EventType": "NewPatient",
 *       "EventDateTime": "2026-05-28T12:00:00Z",
 *       "Test": false,
 *       "Source":      { "ID": "...", "Name": "Acme HIS" },
 *       "Destinations":[{ "ID": "...", "Name": "Mirth"   }]
 *     },
 *     "Patient": { ... }, "Visit": { ... }, ...
 *   }
 *
 * The signature header is named per the channel's subscriber profile —
 * defaults to 'X-Verification-Token'.
 *
 * Tested on: Mirth Connect 4.5.2 against the Redox sandbox webhook
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var REDOX_SECRET     = $cfg('redox.subscriber.secret');
var REDOX_SIG_HEADER = $cfg('redox.subscriber.signature.header') || 'X-Verification-Token';
var REDOX_TIMESTAMP_HEADER = $cfg('redox.subscriber.timestamp.header') || 'X-Verification-Timestamp';
var TIMESTAMP_SKEW_SECONDS = parseInt($cfg('redox.subscriber.timestamp.skew') || '300', 10);

// DataModel + EventType -> FHIR resource type
var EVENT_TYPE_TO_FHIR = {
    'PatientAdmin.NewPatient':   { resource: 'Patient', verb: 'POST' },
    'PatientAdmin.PatientUpdate':{ resource: 'Patient', verb: 'PUT' },
    'Order.New':                 { resource: 'ServiceRequest', verb: 'POST' },
    'Results.New':               { resource: 'DiagnosticReport', verb: 'POST' },
    'Notes.New':                 { resource: 'DocumentReference', verb: 'POST' },
    'Scheduling.New':            { resource: 'Appointment', verb: 'POST' },
    'Scheduling.Modification':   { resource: 'Appointment', verb: 'PUT' },
    'Scheduling.Cancellation':   { resource: 'Appointment', verb: 'PUT' },
    'Vitals.New':                { resource: 'Observation', verb: 'POST' }
};

// Verb -> FHIR bundle entry request.method
function verbToBundleMethod(v) {
    return v === 'PUT' ? 'PUT' : 'POST';
}

// === Helpers ===
function hmacSha256Hex(secret, body) {
    var Mac = Packages.javax.crypto.Mac;
    var SKS = Packages.javax.crypto.spec.SecretKeySpec;
    var mac = Mac.getInstance('HmacSHA256');
    var keySpec = new SKS(new java.lang.String(secret).getBytes('UTF-8'), 'HmacSHA256');
    mac.init(keySpec);
    var bytes = mac.doFinal(new java.lang.String(body).getBytes('UTF-8'));
    var sb = new java.lang.StringBuilder();
    for (var i = 0; i < bytes.length; i++) {
        var hex = java.lang.Integer.toHexString(0xff & bytes[i]);
        if (hex.length() == 1) sb.append('0');
        sb.append(hex);
    }
    return sb.toString() + '';
}

// Constant-time comparison to defeat timing oracles.
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}

function verifyRedoxSignature() {
    if (!REDOX_SECRET) {
        throw new Error('redox.subscriber.secret is not configured');
    }
    var providedSig = sourceMap.get(REDOX_SIG_HEADER) ||
                      sourceMap.get('header_' + REDOX_SIG_HEADER) || '';
    providedSig = (providedSig + '').trim();
    if (!providedSig) {
        throw new Error('missing ' + REDOX_SIG_HEADER + ' header');
    }
    // Replay protection: timestamp must be within +/- skew of now.
    var ts = sourceMap.get(REDOX_TIMESTAMP_HEADER);
    if (ts) {
        var deltaSec = Math.abs((Date.now() - Date.parse(ts + '')) / 1000);
        if (deltaSec > TIMESTAMP_SKEW_SECONDS) {
            throw new Error('signature timestamp drift > ' + TIMESTAMP_SKEW_SECONDS + 's');
        }
    }
    // The body Mirth gives us is the raw POST body (assuming
    // 'Process batch' is disabled and Content-Type is application/json).
    var rawBody = connectorMessage.getRawData() + '';
    var expected = hmacSha256Hex(REDOX_SECRET, ts ? (ts + rawBody) : rawBody);
    if (!timingSafeEqual(expected.toLowerCase(), providedSig.toLowerCase())) {
        throw new Error('redox signature mismatch');
    }
    return true;
}

// === Map Redox payload -> FHIR ===
function mapPatient(redoxPatient) {
    if (!redoxPatient || !redoxPatient.Identifiers) return null;
    var mrn = null;
    for (var i = 0; i < redoxPatient.Identifiers.length; i++) {
        var id = redoxPatient.Identifiers[i];
        if (id.IDType === 'MR' || id.IDType === 'MRN') { mrn = id.ID; break; }
    }
    if (!mrn && redoxPatient.Identifiers.length > 0) {
        mrn = redoxPatient.Identifiers[0].ID;
    }
    var dem = redoxPatient.Demographics || {};
    var genderMap = { 'Male': 'male', 'Female': 'female', 'Other': 'other', 'Unknown': 'unknown' };
    return {
        resourceType: 'Patient',
        id: mrn,
        identifier: redoxPatient.Identifiers.map(function (id) {
            return { type: { text: id.IDType }, system: id.IDType, value: id.ID };
        }),
        active: true,
        name: dem.FirstName ? [{ use: 'official', family: dem.LastName, given: [dem.FirstName] }] : [],
        gender: genderMap[dem.Sex] || 'unknown',
        birthDate: dem.DOB,
        address: dem.Address ? [{
            line: dem.Address.StreetAddress ? [dem.Address.StreetAddress] : [],
            city: dem.Address.City,
            state: dem.Address.State,
            postalCode: dem.Address.ZIP,
            country: dem.Address.Country
        }] : [],
        telecom: dem.PhoneNumber ? Object.keys(dem.PhoneNumber).map(function (k) {
            return { system: 'phone', value: dem.PhoneNumber[k], use: k.toLowerCase() };
        }) : []
    };
}

function mapToFhirBundle(envelope) {
    var key = (envelope.Meta.DataModel || '') + '.' + (envelope.Meta.EventType || '');
    var mapping = EVENT_TYPE_TO_FHIR[key];
    var entries = [];
    var patient = mapPatient(envelope.Patient);
    if (patient) {
        entries.push({
            resource: patient,
            request: { method: verbToBundleMethod(mapping ? mapping.verb : 'POST'), url: 'Patient' + (patient.id ? '/' + patient.id : '') }
        });
    }
    if (envelope.Visit) {
        entries.push({
            resource: {
                resourceType: 'Encounter',
                id: envelope.Visit.VisitNumber,
                status: 'in-progress',
                'class': { code: envelope.Visit.PatientClass || 'AMB' },
                identifier: [{ value: envelope.Visit.VisitNumber }],
                subject: patient ? { reference: 'Patient/' + patient.id } : null
            },
            request: { method: 'PUT', url: 'Encounter/' + envelope.Visit.VisitNumber }
        });
    }
    if (mapping && mapping.resource === 'Observation' && envelope.Observations) {
        for (var o = 0; o < envelope.Observations.length; o++) {
            var ob = envelope.Observations[o];
            entries.push({
                resource: {
                    resourceType: 'Observation',
                    status: 'final',
                    code: { text: ob.Code, coding: [{ code: ob.Code, system: ob.Codeset }] },
                    valueQuantity: ob.Units ? { value: parseFloat(ob.Value), unit: ob.Units } : null,
                    valueString:  ob.Units ? null : ('' + ob.Value),
                    subject: patient ? { reference: 'Patient/' + patient.id } : null,
                    effectiveDateTime: ob.DateTime
                },
                request: { method: 'POST', url: 'Observation' }
            });
        }
    }
    return {
        resourceType: 'Bundle',
        type: 'transaction',
        timestamp: new Date().toISOString(),
        entry: entries
    };
}

// === Inbound path ===
function processInbound() {
    verifyRedoxSignature();
    var envelope = JSON.parse(connectorMessage.getRawData() + '');
    var key = (envelope.Meta.DataModel || '') + '.' + (envelope.Meta.EventType || '');
    var bundle = mapToFhirBundle(envelope);

    channelMap.put('redoxEventKey', key);
    channelMap.put('redoxSourceId', (envelope.Meta.Source && envelope.Meta.Source.ID) || '');
    channelMap.put('redoxIsTest', envelope.Meta.Test ? 'true' : 'false');
    channelMap.put('fhirBundle', JSON.stringify(bundle, null, 2));

    logger.info('Redox inbound: ' + key + ' source=' + (envelope.Meta.Source && envelope.Meta.Source.Name) +
                ' patient=' + (bundle.entry[0] && bundle.entry[0].resource.id) +
                ' entries=' + bundle.entry.length);
}

// === Outbound path ===
// Call from a downstream destination's transformer to wrap an internal
// record in a Redox envelope. Set channelMap.outboundRedox before the
// HTTP Sender destination fires.
function buildOutboundRedox(dataModel, eventType, body) {
    var envelope = {
        Meta: {
            DataModel: dataModel,
            EventType: eventType,
            EventDateTime: new Date().toISOString(),
            Test: false,
            Source:       { ID: $cfg('redox.source.id'),       Name: $cfg('redox.source.name')       || 'Mirth' },
            Destinations: [{ ID: $cfg('redox.destination.id'), Name: $cfg('redox.destination.name')  || 'Downstream' }]
        }
    };
    for (var k in body) {
        if (body.hasOwnProperty(k)) envelope[k] = body[k];
    }
    return envelope;
}

// === Entry point ===
// Route by whether we're on the inbound listener (raw body present) or
// the outbound side (channelMap.redoxOutboundRecord set by upstream).
var outbound = channelMap.get('redoxOutboundRecord');
if (outbound) {
    var record = JSON.parse(outbound + '');
    var env = buildOutboundRedox(record.dataModel, record.eventType, record.body);
    channelMap.put('outboundRedox', JSON.stringify(env));
} else {
    processInbound();
}
