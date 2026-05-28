/**
 * DICOM C-STORE → FHIR R4 ImagingStudy
 *
 * Mirth's built-in DICOM Listener (port 11112 by default) accepts a
 * C-STORE association and exposes the inbound dataset to the channel
 * as a Java DicomObject (dcm4che) AND a base64-encoded raw byte stream
 * in `msg`. This transformer:
 *
 *   1. Reads selected DICOM tags safely (missing tags → null, never throw).
 *   2. Uploads the raw DICOM file to S3/MinIO via HTTP PUT (next destination).
 *   3. Builds a FHIR R4 ImagingStudy resource with:
 *        - identifier   = StudyInstanceUID
 *        - subject      = Patient/{PatientID}
 *        - started      = StudyDate + StudyTime
 *        - modality     = [coded Modality]
 *        - numberOfSeries / numberOfInstances
 *        - series[]     = one entry per SeriesInstanceUID (this message)
 *        - endpoint     = reference to Endpoint resource pointing at the
 *                         S3/MinIO URL where pixel data was stored.
 *   4. Writes the ImagingStudy JSON to channelMap.fhirImagingStudy for
 *      a downstream HTTP Sender to POST to the FHIR server.
 *
 * Use case:
 *   Radiology modalities (CT, MR, US) push studies via DICOM C-STORE.
 *   Pixel data goes to object storage; structured metadata goes to FHIR
 *   so the EHR can render a thumbnail + link, and so the AI imaging
 *   pipeline can find studies by patient.
 *
 * Source connector (Mirth Administrator → Source → DICOM Listener):
 *   - Listener address: 0.0.0.0
 *   - Listener port:    11112
 *   - Application Entity Title (AE): MIRTH
 *   - Storage SOP Classes: enable the ones you need (CT, MR, US, CR, DX...)
 *
 * Destinations (typical):
 *   1. HTTP Sender → S3/MinIO PUT (uses channelMap.s3PutUrl + raw bytes)
 *   2. HTTP Sender → FHIR server POST /ImagingStudy
 *
 * Tested on: Mirth Connect 4.5.2 (dcm4che bundled)
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : null;
var S3_ENDPOINT     = (cfg && cfg.get('dicom.s3.endpoint'))   || 'http://minio:9000';
var S3_BUCKET       = (cfg && cfg.get('dicom.s3.bucket'))     || 'dicom-raw';
var FHIR_BASE       = (cfg && cfg.get('fhir.base.url'))       || 'http://localhost:8089/fhir';

// Which tags to extract — keep this list in sync with the ImagingStudy
// fields you populate. Comma-separated list of hex tags (no '0x' prefix).
// Defaults cover the IHE Scheduled Workflow set.
var EXTRACT_TAGS = ('' + ((cfg && cfg.get('dicom.extract.tags')) ||
    '00100010,00100020,00100030,00100040,' + // Patient: Name, ID, DOB, Sex
    '0020000D,0020000E,00080018,'           + // Study/Series/SOP Instance UID
    '00080020,00080030,00080050,'           + // Study Date/Time/Accession#
    '00080060,00080068,00081030,'           + // Modality, Presentation Intent, Study Description
    '0008103E,00180015,'                    + // Series Description, Body Part Examined
    '00080090,00081050,'                    + // Referring/Performing Physician
    '00200010,00200011,00200013'              // Study/Series/Instance Numbers
).split(',')).map(function (s) { return ('' + s).trim().toUpperCase(); }).filter(function (s) { return s; });

// =====================================================================
// HELPERS
// =====================================================================

/**
 * Safe access to a DICOM tag value. Tag is hex string, e.g. '00100020'.
 * Returns null if absent. Never throws.
 *
 * Mirth exposes the inbound DICOM dataset two ways:
 *   (a) `connectorMessage.getRawData()` → base64 of the full DICOM file
 *   (b) `msg` as XML when "Process DICOM" is on
 * We use a third path: parse the raw bytes back into a dcm4che
 * DicomObject ourselves so we control which tags to grab without
 * relying on Mirth's XML mapper (which truncates long values).
 */
function loadDicomObject(rawBase64) {
    var bytes = Packages.org.apache.commons.codec.binary.Base64.decodeBase64(rawBase64);
    var bais  = new Packages.java.io.ByteArrayInputStream(bytes);
    var din   = new Packages.org.dcm4che3.io.DicomInputStream(bais);
    try {
        return din.readDataset(-1, -1);
    } finally {
        try { din.close(); } catch (e) {}
    }
}

function tagInt(hex) {
    return parseInt(hex, 16) | 0;
}

function getStr(dcm, hex) {
    try {
        var v = dcm.getString(tagInt(hex));
        return (v === null || v === undefined) ? null : ('' + v);
    } catch (e) {
        logger.debug('Tag ' + hex + ' not present');
        return null;
    }
}

function getInt(dcm, hex, defVal) {
    var s = getStr(dcm, hex);
    if (s == null) return defVal;
    var n = parseInt(s, 10);
    return isNaN(n) ? defVal : n;
}

/**
 * DICOM DA (YYYYMMDD) + TM (HHMMSS[.FFFFFF]) → ISO 8601.
 */
function dicomDateTimeToIso(da, tm) {
    if (!da || da.length < 8) return null;
    var year  = da.substring(0, 4);
    var month = da.substring(4, 6);
    var day   = da.substring(6, 8);
    var hh = '00', mm = '00', ss = '00';
    if (tm && tm.length >= 6) {
        hh = tm.substring(0, 2);
        mm = tm.substring(2, 4);
        ss = tm.substring(4, 6);
    }
    return year + '-' + month + '-' + day + 'T' + hh + ':' + mm + ':' + ss + 'Z';
}

/**
 * DICOM PN (Person Name) "LAST^FIRST^MIDDLE^PREFIX^SUFFIX" → FHIR HumanName.
 */
function dicomPnToFhirName(pn) {
    if (!pn) return null;
    var parts = ('' + pn).split('^');
    var name = { use: 'official' };
    if (parts[0]) name.family = parts[0];
    var given = [];
    if (parts[1]) given.push(parts[1]);
    if (parts[2]) given.push(parts[2]);
    if (given.length) name.given = given;
    if (parts[3]) name.prefix = [parts[3]];
    if (parts[4]) name.suffix = [parts[4]];
    return name;
}

/**
 * Build a deterministic S3 object key. Use StudyInstanceUID + SOPInstanceUID
 * so retries are idempotent (same UIDs → same object).
 */
function s3KeyFor(studyUid, sopUid) {
    return 'studies/' + studyUid + '/' + sopUid + '.dcm';
}

// =====================================================================
// MAIN
// =====================================================================

var dcm;
try {
    // `msg` from a DICOM Listener channel with the default settings is
    // the base64-encoded DICOM. Some Mirth versions strip the header —
    // be defensive.
    var raw = '' + (msg || '');
    raw = raw.replace(/<[^>]+>/g, '');           // strip any XML wrapper
    raw = raw.replace(/\s+/g, '');               // strip whitespace
    dcm = loadDicomObject(raw);
} catch (parseErr) {
    logger.error('DICOM parse failed: ' + parseErr);
    throw parseErr;     // let Mirth queue/retry
}

// === Extract requested tags into a flat map for downstream use ===
var extracted = {};
for (var i = 0; i < EXTRACT_TAGS.length; i++) {
    extracted[EXTRACT_TAGS[i]] = getStr(dcm, EXTRACT_TAGS[i]);
}

// === Pull the well-known tags into named vars ===
var patientId       = getStr(dcm, '00100020') || 'UNKNOWN';
var patientName     = getStr(dcm, '00100010');
var patientBirth    = getStr(dcm, '00100030');   // YYYYMMDD
var patientSex      = getStr(dcm, '00100040');

var studyUid        = getStr(dcm, '0020000D');
var seriesUid       = getStr(dcm, '0020000E');
var sopUid          = getStr(dcm, '00080018');
var accessionNum    = getStr(dcm, '00080050');
var modality        = getStr(dcm, '00080060') || 'OT';
var studyDate       = getStr(dcm, '00080020');
var studyTime       = getStr(dcm, '00080030');
var studyDesc       = getStr(dcm, '00081030');
var seriesDesc      = getStr(dcm, '0008103E');
var bodyPart        = getStr(dcm, '00180015');
var referringPhys   = getStr(dcm, '00080090');
var seriesNumber    = getInt(dcm, '00200011', null);
var instanceNumber  = getInt(dcm, '00200013', null);

if (!studyUid || !seriesUid || !sopUid) {
    logger.error('Missing required UID(s): study=' + studyUid + ' series=' + seriesUid + ' sop=' + sopUid);
    throw new Error('DICOM dataset missing required UIDs');
}

// === Compute S3 destination URL for downstream HTTP Sender ===
var s3Key = s3KeyFor(studyUid, sopUid);
var s3Url = S3_ENDPOINT.replace(/\/$/, '') + '/' + S3_BUCKET + '/' + s3Key;
channelMap.put('s3PutUrl', s3Url);
channelMap.put('s3ObjectKey', s3Key);

// === Build ImagingStudy ===
var imagingStudy = {
    resourceType: 'ImagingStudy',
    identifier: [{
        system: 'urn:dicom:uid',
        value:  'urn:oid:' + studyUid
    }],
    status: 'available',
    subject: { reference: 'Patient/' + patientId },
    started: dicomDateTimeToIso(studyDate, studyTime),
    numberOfSeries: 1,
    numberOfInstances: 1,
    modality: [{
        system:  'http://dicom.nema.org/resources/ontology/DCM',
        code:    modality,
        display: modality
    }],
    series: [{
        uid: seriesUid,
        number: seriesNumber,
        modality: {
            system:  'http://dicom.nema.org/resources/ontology/DCM',
            code:    modality,
            display: modality
        },
        description: seriesDesc || studyDesc || null,
        numberOfInstances: 1,
        bodySite: bodyPart ? {
            system: 'http://snomed.info/sct',   // best-effort mapping; refine via your terminology server
            display: bodyPart
        } : null,
        instance: [{
            uid: sopUid,
            number: instanceNumber,
            sopClass: {
                system: 'urn:ietf:rfc:3986',
                code:   'urn:oid:' + (getStr(dcm, '00080016') || '1.2.840.10008.5.1.4.1.1.7')
            }
        }],
        endpoint: [{
            reference: 'Endpoint/dicom-storage',
            display:   s3Url
        }]
    }],
    endpoint: [{
        reference: 'Endpoint/dicom-storage',
        display:   s3Url
    }]
};

if (accessionNum) {
    imagingStudy.identifier.push({
        system: 'http://hospital.example.org/accession',
        value:  accessionNum
    });
}
if (studyDesc) imagingStudy.description = studyDesc;
if (referringPhys) {
    imagingStudy.referrer = { display: referringPhys.replace(/\^/g, ' ').trim() };
}

// Strip nulls so the JSON is clean. (FHIR validators reject most explicit nulls.)
function pruneNulls(obj) {
    if (obj === null || obj === undefined) return undefined;
    if (Array.isArray(obj)) {
        var out = [];
        for (var k = 0; k < obj.length; k++) {
            var v = pruneNulls(obj[k]);
            if (v !== undefined) out.push(v);
        }
        return out.length ? out : undefined;
    }
    if (typeof obj === 'object') {
        var o2 = {};
        for (var key in obj) if (obj.hasOwnProperty(key)) {
            var vv = pruneNulls(obj[key]);
            if (vv !== undefined) o2[key] = vv;
        }
        return o2;
    }
    return obj;
}
var cleanStudy = pruneNulls(imagingStudy);

// === Surface to downstream destinations ===
channelMap.put('fhirImagingStudy', JSON.stringify(cleanStudy));
channelMap.put('dicomExtractedTags', JSON.stringify(extracted));
channelMap.put('dicomSummary', JSON.stringify({
    patientId: patientId,
    patientName: patientName,
    studyUid: studyUid,
    seriesUid: seriesUid,
    sopUid: sopUid,
    modality: modality,
    accession: accessionNum,
    s3Url: s3Url,
    bytes: ('' + msg).length
}));

logger.info('DICOM C-STORE → ImagingStudy: patient=' + patientId +
    ' modality=' + modality + ' study=' + studyUid + ' s3=' + s3Url);

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        dicomDateTimeToIso: dicomDateTimeToIso,
        dicomPnToFhirName: dicomPnToFhirName,
        s3KeyFor: s3KeyFor,
        pruneNulls: pruneNulls
    };
}
