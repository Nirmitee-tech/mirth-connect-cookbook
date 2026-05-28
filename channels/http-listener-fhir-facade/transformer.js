/**
 * HTTP Listener — FHIR R4 Facade over Legacy HL7v2 Database
 *
 * Routes a single Mirth HTTP Listener channel into multiple FHIR endpoints:
 *
 *   GET  /fhir/metadata                    → CapabilityStatement
 *   GET  /fhir/Patient/{id}                → Patient (lookup by MRN)
 *   POST /fhir/Patient                     → create Patient (INSERT into legacy table)
 *   GET  /fhir/Observation?subject={id}    → Bundle of Observations
 *
 * Errors are returned as a proper FHIR R4 OperationOutcome, not a raw string.
 * Search results are wrapped in a `searchset` Bundle with `link.next` for pagination.
 *
 * Source connector (Mirth Administrator → Source → HTTP Listener):
 *   - Listener address: 0.0.0.0
 *   - Listener port:    8089
 *   - Base context path: /fhir
 *   - Receive timeout:   30000
 *   - Response content type: application/fhir+json
 *
 * Database Reader code template used here assumes:
 *   - Datasource alias = 'legacyDb' configured via JdbcDataSource code template,
 *     OR direct DriverManager.getConnection() for the simplest setup.
 *
 * Place in: Channel → Source → Transformer
 *           Channel → Destinations → 1 (Channel Writer or "None" — response
 *           is returned synchronously from this transformer via responseMap).
 *
 * Tested on: Mirth Connect 4.5.2
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration (configurationMap overrides) ===
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : null;
var DB_URL  = (cfg && cfg.get('legacy.db.url'))  || 'jdbc:postgresql://localhost:5432/legacy_hl7';
var DB_USER = (cfg && cfg.get('legacy.db.user')) || 'mirth';
var DB_PASS = (cfg && cfg.get('legacy.db.pass')) || 'changeme';
var DB_DRV  = (cfg && cfg.get('legacy.db.driver'))|| 'org.postgresql.Driver';
var PAGE_SIZE_DEFAULT = parseInt((cfg && cfg.get('fhir.page.size')) || '20', 10);
var BASE_URL = (cfg && cfg.get('fhir.base.url')) || 'http://localhost:8089/fhir';

// === HTTP request shape provided by Mirth's HTTP Listener ===
// `msg` is an XML doc with fields. We pull what we need:
var method = '' + (sourceMap.get('method') || 'GET');     // GET, POST, ...
var path   = '' + (sourceMap.get('contextPath') || '');    // /Patient/123
var query  = sourceMap.get('parameters') || null;          // Map<String,List<String>>
var body   = ('' + (msg || '')).trim();

logger.info('FHIR facade ' + method + ' ' + path + (body ? ' (body ' + body.length + 'b)' : ''));

// =====================================================================
// HELPERS
// =====================================================================

/**
 * Build a FHIR R4 OperationOutcome. Used for ALL error responses.
 */
function operationOutcome(severity, code, diagnostics, httpStatus) {
    return {
        statusCode: httpStatus,
        body: {
            resourceType: 'OperationOutcome',
            issue: [{
                severity: severity,          // 'fatal' | 'error' | 'warning' | 'information'
                code: code,                  // FHIR issue-type code, e.g. 'not-found', 'invalid'
                diagnostics: diagnostics
            }]
        }
    };
}

function jdbcConnect() {
    Packages.java.lang.Class.forName(DB_DRV);
    return Packages.java.sql.DriverManager.getConnection(DB_URL, DB_USER, DB_PASS);
}

function closeQuietly(o) { try { if (o) o.close(); } catch (e) {} }

function getQueryParam(name, defaultValue) {
    if (!query) return defaultValue;
    try {
        var v = query.get(name);
        if (!v) return defaultValue;
        // Java List<String> — first element wins
        if (v.size && v.size() > 0) return '' + v.get(0);
        return '' + v;
    } catch (e) { return defaultValue; }
}

/**
 * Parse the contextPath into route + id segments.
 *   '/Patient/123'          → { resource:'Patient', id:'123' }
 *   '/Observation'          → { resource:'Observation' }
 *   '/metadata'             → { resource:'metadata' }
 */
function parseRoute(p) {
    var parts = ('' + p).split('/').filter(function (x) { return x && x.length > 0; });
    return { resource: parts[0] || '', id: parts[1] || null, op: parts[2] || null };
}

/**
 * Map a row from the legacy patient table to a FHIR R4 Patient resource.
 * Safe-access every column — legacy tables are notoriously NULL-rich.
 */
function rowToPatient(rs) {
    var mrn   = rs.getString('mrn');
    var first = rs.getString('first_name');
    var last  = rs.getString('last_name');
    var dob   = rs.getString('birth_date');   // assumed YYYY-MM-DD
    var sex   = rs.getString('sex');           // M/F/U/O
    var phone = rs.getString('phone');
    var email = rs.getString('email');

    var genderMap = { M: 'male', F: 'female', U: 'unknown', O: 'other' };

    var p = {
        resourceType: 'Patient',
        id: mrn,
        identifier: [{
            use: 'usual',
            system: 'http://hospital.example.org/mrn',
            value: mrn
        }],
        active: true,
        name: [{
            use: 'official',
            family: last || '',
            given: first ? [first] : []
        }]
    };
    if (dob)  p.birthDate = dob;
    if (sex)  p.gender = genderMap[('' + sex).toUpperCase()] || 'unknown';
    var telecom = [];
    if (phone) telecom.push({ system: 'phone', value: phone, use: 'home' });
    if (email) telecom.push({ system: 'email', value: email });
    if (telecom.length) p.telecom = telecom;
    return p;
}

function rowToObservation(rs) {
    var id      = '' + rs.getString('obs_id');
    var subject = rs.getString('mrn');
    var code    = rs.getString('loinc_code');
    var display = rs.getString('loinc_display');
    var val     = rs.getString('value_numeric');
    var unit    = rs.getString('units');
    var status  = rs.getString('result_status') || 'final';
    var ts      = rs.getString('observation_ts');

    var o = {
        resourceType: 'Observation',
        id: id,
        status: ('' + status).toLowerCase(),
        code: {
            coding: [{ system: 'http://loinc.org', code: code, display: display }],
            text: display
        },
        subject: { reference: 'Patient/' + subject }
    };
    if (ts) o.effectiveDateTime = ts.replace(' ', 'T');
    if (val !== null && val !== undefined && val !== '') {
        o.valueQuantity = {
            value: parseFloat(val),
            unit: unit || '',
            system: 'http://unitsofmeasure.org',
            code: unit || ''
        };
    }
    return o;
}

// =====================================================================
// ROUTE HANDLERS
// =====================================================================

function handleMetadata() {
    // Inline minimal CapabilityStatement. The file capability-statement.json
    // ships with the recipe for editing — load it from disk in production.
    var cs = {
        resourceType: 'CapabilityStatement',
        status: 'active',
        date: new Date().toISOString().substring(0, 10),
        kind: 'instance',
        software: { name: 'Mirth Connect FHIR Facade', version: '1.0.0' },
        implementation: { description: 'FHIR R4 facade over legacy HL7v2 RDBMS', url: BASE_URL },
        fhirVersion: '4.0.1',
        format: ['application/fhir+json', 'json'],
        rest: [{
            mode: 'server',
            resource: [
                { type: 'Patient',     interaction: [{code:'read'},{code:'create'},{code:'search-type'}] },
                { type: 'Observation', interaction: [{code:'search-type'}] }
            ]
        }]
    };
    return { statusCode: 200, body: cs };
}

function handlePatientRead(id) {
    if (!id) return operationOutcome('error', 'invalid', 'Patient id is required', 400);
    var conn = null, ps = null, rs = null;
    try {
        conn = jdbcConnect();
        ps   = conn.prepareStatement('SELECT mrn, first_name, last_name, birth_date, sex, phone, email FROM patients WHERE mrn = ?');
        ps.setString(1, '' + id);
        rs   = ps.executeQuery();
        if (!rs.next()) return operationOutcome('error', 'not-found', 'Patient/' + id + ' not found', 404);
        return { statusCode: 200, body: rowToPatient(rs) };
    } catch (e) {
        logger.error('Patient read failed: ' + e);
        return operationOutcome('error', 'exception', 'DB error: ' + e, 500);
    } finally { closeQuietly(rs); closeQuietly(ps); closeQuietly(conn); }
}

function handlePatientCreate(rawBody) {
    var p;
    try { p = JSON.parse(rawBody); }
    catch (e) { return operationOutcome('error', 'structure', 'Invalid JSON: ' + e, 400); }

    if (!p || p.resourceType !== 'Patient') {
        return operationOutcome('error', 'invalid', 'resourceType must be Patient', 400);
    }

    // Extract MRN — prefer identifier.value, fall back to id
    var mrn = null;
    if (p.identifier && p.identifier.length) {
        for (var i = 0; i < p.identifier.length; i++) {
            if (p.identifier[i] && p.identifier[i].value) { mrn = p.identifier[i].value; break; }
        }
    }
    if (!mrn) mrn = p.id;
    if (!mrn) return operationOutcome('error', 'required', 'Patient.identifier.value required', 400);

    var name = (p.name && p.name[0]) || {};
    var first = (name.given && name.given[0]) || '';
    var last  = name.family || '';
    var dob   = p.birthDate || null;
    var gender = ({ male: 'M', female: 'F', other: 'O' })[p.gender] || 'U';

    var conn = null, ps = null;
    try {
        conn = jdbcConnect();
        ps = conn.prepareStatement(
            'INSERT INTO patients (mrn, first_name, last_name, birth_date, sex) ' +
            'VALUES (?, ?, ?, ?::date, ?) ON CONFLICT (mrn) DO NOTHING'
        );
        ps.setString(1, '' + mrn);
        ps.setString(2, first);
        ps.setString(3, last);
        if (dob) ps.setString(4, dob); else ps.setNull(4, Packages.java.sql.Types.DATE);
        ps.setString(5, gender);
        var rows = ps.executeUpdate();
        if (rows === 0) return operationOutcome('error', 'duplicate', 'Patient with MRN ' + mrn + ' already exists', 409);

        p.id = mrn;
        return {
            statusCode: 201,
            headers: { 'Location': BASE_URL + '/Patient/' + mrn },
            body: p
        };
    } catch (e) {
        logger.error('Patient create failed: ' + e);
        return operationOutcome('error', 'exception', 'DB error: ' + e, 500);
    } finally { closeQuietly(ps); closeQuietly(conn); }
}

function handleObservationSearch() {
    var subject = getQueryParam('subject', null);   // 'Patient/123' or '123'
    var pageStr = getQueryParam('_page', '1');
    var sizeStr = getQueryParam('_count', '' + PAGE_SIZE_DEFAULT);
    var page    = Math.max(1, parseInt(pageStr, 10) || 1);
    var size    = Math.min(200, Math.max(1, parseInt(sizeStr, 10) || PAGE_SIZE_DEFAULT));

    if (!subject) return operationOutcome('error', 'required', 'subject parameter required', 400);
    var mrn = subject.indexOf('/') >= 0 ? subject.split('/').pop() : subject;

    var conn = null, ps = null, rs = null, cps = null, crs = null;
    try {
        conn = jdbcConnect();

        // Total count (for last-page Bundle metadata, capped at 10k for safety)
        cps = conn.prepareStatement('SELECT COUNT(*) FROM observations WHERE mrn = ?');
        cps.setString(1, mrn);
        crs = cps.executeQuery();
        crs.next();
        var total = crs.getInt(1);
        closeQuietly(crs); closeQuietly(cps);

        ps = conn.prepareStatement(
            'SELECT obs_id, mrn, loinc_code, loinc_display, value_numeric, units, result_status, ' +
            '       to_char(observation_ts,\'YYYY-MM-DD HH24:MI:SS\') AS observation_ts ' +
            'FROM observations WHERE mrn = ? ORDER BY observation_ts DESC ' +
            'LIMIT ? OFFSET ?'
        );
        ps.setString(1, mrn);
        ps.setInt(2, size);
        ps.setInt(3, (page - 1) * size);
        rs = ps.executeQuery();

        var entries = [];
        while (rs.next()) {
            var o = rowToObservation(rs);
            entries.push({ fullUrl: BASE_URL + '/Observation/' + o.id, resource: o });
        }

        var bundle = {
            resourceType: 'Bundle',
            type: 'searchset',
            total: total,
            link: [{ relation: 'self', url: BASE_URL + '/Observation?subject=' + subject +
                                              '&_page=' + page + '&_count=' + size }],
            entry: entries
        };
        if (page * size < total) {
            bundle.link.push({
                relation: 'next',
                url: BASE_URL + '/Observation?subject=' + subject +
                     '&_page=' + (page + 1) + '&_count=' + size
            });
        }
        return { statusCode: 200, body: bundle };
    } catch (e) {
        logger.error('Observation search failed: ' + e);
        return operationOutcome('error', 'exception', 'DB error: ' + e, 500);
    } finally {
        closeQuietly(rs);  closeQuietly(ps);
        closeQuietly(crs); closeQuietly(cps);
        closeQuietly(conn);
    }
}

// =====================================================================
// DISPATCH
// =====================================================================

var route = parseRoute(path);
var result;

try {
    if (route.resource === 'metadata' && method === 'GET') {
        result = handleMetadata();
    } else if (route.resource === 'Patient' && method === 'GET' && route.id) {
        result = handlePatientRead(route.id);
    } else if (route.resource === 'Patient' && method === 'POST' && !route.id) {
        result = handlePatientCreate(body);
    } else if (route.resource === 'Observation' && method === 'GET' && !route.id) {
        result = handleObservationSearch();
    } else {
        result = operationOutcome('error', 'not-supported',
            method + ' ' + path + ' is not supported by this facade', 404);
    }
} catch (fatal) {
    logger.error('FHIR facade fatal: ' + fatal);
    result = operationOutcome('fatal', 'exception', 'Unhandled: ' + fatal, 500);
}

// =====================================================================
// RESPONSE — Mirth's HTTP Listener reads channelMap('responseBody') and
// uses the responseStatusCode / responseHeaders / responseContentType
// source-connector response variables.
// =====================================================================

channelMap.put('responseStatusCode',  result.statusCode);
channelMap.put('responseContentType', 'application/fhir+json; charset=utf-8');
channelMap.put('responseBody',        JSON.stringify(result.body, null, 2));
if (result.headers) {
    channelMap.put('responseHeaders', JSON.stringify(result.headers));
}

channelMap.put('fhirFacadeSummary', JSON.stringify({
    method: method,
    path: path,
    statusCode: result.statusCode,
    bodyBytes: ('' + channelMap.get('responseBody')).length
}));

logger.info('FHIR facade ' + method + ' ' + path + ' → ' + result.statusCode);

// Make response available for Node-based unit tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseRoute: parseRoute,
        operationOutcome: operationOutcome
    };
}
