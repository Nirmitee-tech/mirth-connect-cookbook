/**
 * Recipe #31 — PHI Masking Code Template for Mirth Connect
 *
 * Reusable masking helpers for HL7v2, FHIR JSON, and arbitrary strings.
 * Masking is gated by configurationMap['phi.masking.enabled'] so the same code
 * deploys to dev / staging / prod and ONLY masks where you intend.
 *
 * REQUIREMENTS:
 *   1. Paste this into Mirth Administrator -> Code Templates -> add Library "Security"
 *      -> add Code Template "PHI Masking" -> Type: Function, Context: All.
 *   2. In configurationMap set:
 *         phi.masking.enabled  = true       (or false)
 *         phi.masking.profile  = full|partial|hash   (default partial)
 *   3. From any transformer:
 *         var masked = maskPHI(connectorMessage.getRawData());
 *         logger.info(masked);
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

/* ----------------------------------------------------------------------------
 * Configuration accessor (works in transformer + deploy script contexts)
 * -------------------------------------------------------------------------- */
function _maskingEnabled() {
    try {
        var v = configurationMap.get('phi.masking.enabled');
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase() === 'true';
    } catch (e) {
        // configurationMap not in scope (unit test) — default off
        return false;
    }
}

function _maskingProfile() {
    try {
        var p = configurationMap.get('phi.masking.profile');
        return p ? String(p) : 'partial';
    } catch (e) {
        return 'partial';
    }
}

/* ----------------------------------------------------------------------------
 * Primitive maskers
 * -------------------------------------------------------------------------- */

/** SSN: 123-45-6789 -> XXX-XX-6789 (partial) or XXX-XX-XXXX (full) */
function _maskSSN(s, profile) {
    return s.replace(/\b(\d{3})-(\d{2})-(\d{4})\b/g, function (_m, _a, _b, last4) {
        return profile === 'full' ? 'XXX-XX-XXXX' : 'XXX-XX-' + last4;
    });
}

/** DOB: yyyy-mm-dd -> yyyy-XX-XX (HIPAA Safe Harbor preserves year for >89 only;
 *  for everyone else, preserve year only). Also handles HL7 dates yyyymmdd. */
function _maskDOB(s) {
    s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$1-XX-XX');
    s = s.replace(/\b(\d{4})(\d{2})(\d{2})\b/g, function (m, y) {
        // Avoid clobbering HL7 timestamps yyyymmddhhmmss — only 8-digit boundary
        return (m.length === 8) ? (y + 'XXXX') : m;
    });
    return s;
}

/** US phone numbers: 555-555-5555, (555) 555-5555, 5555555555 -> ###-###-#### */
function _maskPhone(s) {
    return s
        .replace(/\b\d{3}-\d{3}-\d{4}\b/g, '###-###-####')
        .replace(/\(\d{3}\)\s?\d{3}-\d{4}/g, '(###) ###-####')
        .replace(/\b\d{10}\b/g, '##########');
}

/** Email: jane.doe@example.com -> J***@example.com */
function _maskEmail(s) {
    return s.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
        function (_m, first, domain) { return first + '***@' + domain; });
}

/** MRN: digits >=6 -> show last 4. Use only inside HL7/FHIR mask wrappers. */
function _maskMRN(s) {
    if (!s || s.length < 4) return '****';
    if (s.length <= 4)      return s;
    return new Array(s.length - 3).join('*') + s.substring(s.length - 4);
}

/* ----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Mask common PHI patterns in free text (logs, error messages, etc).
 * Honors configurationMap.phi.masking.enabled.
 *
 * @param {string} text
 * @returns {string}
 */
function maskPHI(text) {
    if (text === null || text === undefined) return text;
    if (!_maskingEnabled()) return text;
    var s = String(text);
    var profile = _maskingProfile();
    s = _maskSSN(s, profile);
    s = _maskDOB(s);
    s = _maskPhone(s);
    s = _maskEmail(s);
    return s;
}

/**
 * Mask a specific HL7 v2 segment by type. Operates on a pipe-delimited segment
 * string (e.g. 'PID|1||MRN123||DOE^JOHN^A...') and returns a new string.
 *
 * Supported segmentTypes: PID, NK1, GT1, IN1, OBX (free-text observations)
 *
 * @param {string} segment    raw HL7 segment text
 * @param {string} segmentType e.g. 'PID'
 * @returns {string}
 */
function maskHL7Segment(segment, segmentType) {
    if (!_maskingEnabled()) return segment;
    if (!segment || !segmentType) return segment;

    var fields = String(segment).split('|');
    if (fields[0] !== segmentType) return segment;

    switch (segmentType) {
        case 'PID':
            // PID-3: patient identifier list (CX) — mask the ID
            if (fields[3]) {
                fields[3] = fields[3].split('~').map(function (cx) {
                    var parts = cx.split('^');
                    parts[0] = _maskMRN(parts[0] || '');
                    return parts.join('^');
                }).join('~');
            }
            // PID-5: patient name (XPN repeating) — full redact
            if (fields[5]) fields[5] = 'REDACTED^REDACTED';
            // PID-7: DOB
            if (fields[7]) fields[7] = _maskDOB(fields[7]);
            // PID-11: address (XAD) — drop street, keep state/zip first 3
            if (fields[11]) {
                fields[11] = fields[11].split('~').map(function (xad) {
                    var p = xad.split('^');
                    p[0] = 'REDACTED';                 // street
                    if (p[4]) p[4] = (p[4] + '00000').substring(0, 3) + 'XX'; // zip
                    return p.join('^');
                }).join('~');
            }
            // PID-13: home phone, PID-14: business phone
            if (fields[13]) fields[13] = _maskPhone(fields[13]);
            if (fields[14]) fields[14] = _maskPhone(fields[14]);
            // PID-19: SSN
            if (fields[19]) fields[19] = _maskSSN(fields[19], _maskingProfile());
            break;

        case 'NK1':
            if (fields[2])  fields[2]  = 'REDACTED^REDACTED'; // name
            if (fields[4])  fields[4]  = 'REDACTED';          // address
            if (fields[5])  fields[5]  = _maskPhone(fields[5]);
            if (fields[6])  fields[6]  = _maskPhone(fields[6]);
            break;

        case 'GT1':
            if (fields[3])  fields[3]  = 'REDACTED^REDACTED';
            if (fields[5])  fields[5]  = 'REDACTED';
            if (fields[6])  fields[6]  = _maskPhone(fields[6]);
            if (fields[7])  fields[7]  = _maskPhone(fields[7]);
            if (fields[8])  fields[8]  = _maskDOB(fields[8]);
            if (fields[12]) fields[12] = _maskSSN(fields[12], _maskingProfile());
            break;

        case 'IN1':
            if (fields[16]) fields[16] = 'REDACTED^REDACTED'; // subscriber name
            if (fields[18]) fields[18] = _maskDOB(fields[18]);
            if (fields[36]) fields[36] = _maskMRN(fields[36]); // policy number
            break;

        case 'OBX':
            // OBX-5 free-text result — only mask if value type is TX or FT
            if (fields[2] === 'TX' || fields[2] === 'FT') {
                if (fields[5]) fields[5] = maskPHI(fields[5]);
            }
            break;
    }

    return fields.join('|');
}

/**
 * Mask a FHIR JSON resource. Returns a new object — does not mutate input.
 *
 * Supports: Patient, RelatedPerson, Practitioner, Coverage, Observation.
 * For other resource types, recursively scans string fields for PHI patterns.
 *
 * @param {object|string} resource   FHIR resource (object or JSON string)
 * @returns {object}
 */
function maskFHIRResource(resource) {
    if (!_maskingEnabled()) {
        return (typeof resource === 'string') ? JSON.parse(resource) : resource;
    }
    var r = (typeof resource === 'string') ? JSON.parse(resource) : JSON.parse(JSON.stringify(resource));
    if (!r || !r.resourceType) return r;

    switch (r.resourceType) {
        case 'Patient':
        case 'RelatedPerson':
        case 'Practitioner':
            if (Array.isArray(r.identifier)) {
                r.identifier.forEach(function (id) { if (id.value) id.value = _maskMRN(id.value); });
            }
            if (Array.isArray(r.name)) {
                r.name = r.name.map(function () { return { family: 'REDACTED', given: ['REDACTED'] }; });
            }
            if (r.birthDate) r.birthDate = r.birthDate.substring(0, 4) + '-XX-XX';
            if (Array.isArray(r.telecom)) {
                r.telecom.forEach(function (t) {
                    if (t.system === 'phone' && t.value) t.value = _maskPhone(t.value);
                    if (t.system === 'email' && t.value) t.value = _maskEmail(t.value);
                });
            }
            if (Array.isArray(r.address)) {
                r.address.forEach(function (a) {
                    if (a.line) a.line = ['REDACTED'];
                    if (a.postalCode) a.postalCode = a.postalCode.substring(0, 3) + 'XX';
                });
            }
            break;

        case 'Coverage':
            if (r.subscriberId) r.subscriberId = _maskMRN(r.subscriberId);
            if (Array.isArray(r.identifier)) {
                r.identifier.forEach(function (id) { if (id.value) id.value = _maskMRN(id.value); });
            }
            break;

        case 'Observation':
            if (r.valueString) r.valueString = maskPHI(r.valueString);
            if (Array.isArray(r.note)) r.note.forEach(function (n) { if (n.text) n.text = maskPHI(n.text); });
            break;

        default:
            // Best-effort sweep of any string property
            _walkStrings(r, function (s) { return maskPHI(s); });
    }

    return r;
}

function _walkStrings(node, fn) {
    if (!node || typeof node !== 'object') return;
    for (var k in node) {
        if (!node.hasOwnProperty(k)) continue;
        var v = node[k];
        if (typeof v === 'string') node[k] = fn(v);
        else if (typeof v === 'object') _walkStrings(v, fn);
    }
}

/* ----------------------------------------------------------------------------
 * Export for unit testing under Node (skipped at runtime inside Mirth/Rhino)
 * -------------------------------------------------------------------------- */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        maskPHI: maskPHI,
        maskHL7Segment: maskHL7Segment,
        maskFHIRResource: maskFHIRResource,
        _internals: {
            _maskSSN: _maskSSN, _maskDOB: _maskDOB, _maskPhone: _maskPhone,
            _maskEmail: _maskEmail, _maskMRN: _maskMRN
        }
    };
}
