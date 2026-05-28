/**
 * ICD-10 → SNOMED CT Crosswalk for Mirth Connect
 *
 * Local mapping table for the 50 most common ICD-10 codes seen in HL7v2 ADT/DG1 segments.
 * Use for dual coding on FHIR Condition.code.coding[] arrays.
 *
 * For codes not in this table, fall back to ICD-10-CM only OR call tx.fhir.org
 * for live validation (see ../tx-server-validation/).
 *
 * Author: Nirmitee.io | License: MIT
 */

var ICD_TO_SNOMED = {
    // Sepsis & infections
    'A41.9':  { code: '91302008',  display: 'Sepsis (disorder)' },
    'A41.51': { code: '432119003', display: 'Sepsis due to Escherichia coli' },
    'R65.21': { code: '76571007',  display: 'Septic shock (disorder)' },
    'B95.61': { code: '116101000119109', display: 'MSSA infection' },
    'B95.62': { code: '113721000119104', display: 'MRSA infection' },

    // Cardiovascular
    'I21.9':  { code: '22298006',  display: 'Myocardial infarction (disorder)' },
    'I21.0':  { code: '233827002', display: 'Anterior wall MI' },
    'I21.4':  { code: '401303003', display: 'Acute STEMI' },
    'I46.9':  { code: '410429000', display: 'Cardiac arrest (disorder)' },
    'I50.9':  { code: '84114007',  display: 'Heart failure (disorder)' },
    'I10':    { code: '38341003',  display: 'Hypertensive disorder' },
    'I48.91': { code: '49436004',  display: 'Atrial fibrillation' },

    // Cerebrovascular
    'I63.9':  { code: '230690007', display: 'Cerebrovascular accident (disorder)' },
    'I61.9':  { code: '274100004', display: 'Cerebral hemorrhage' },
    'G45.9':  { code: '266257000', display: 'Transient ischemic attack' },

    // Respiratory
    'J18.9':  { code: '233604007', display: 'Pneumonia (disorder)' },
    'J96.00': { code: '409622000', display: 'Acute respiratory failure' },
    'J44.1':  { code: '195951007', display: 'Acute exacerbation of COPD' },
    'J45.901':{ code: '195967001', display: 'Asthma exacerbation' },
    'J06.9':  { code: '54150009',  display: 'Upper respiratory infection' },
    'U07.1':  { code: '840539006', display: 'COVID-19 (disorder)' },

    // Diabetes
    'E11.9':  { code: '44054006',  display: 'Diabetes mellitus type 2' },
    'E10.9':  { code: '46635009',  display: 'Diabetes mellitus type 1' },
    'E11.65': { code: '443694000', display: 'Type 2 DM with hyperglycemia' },
    'E10.10': { code: '420422005', display: 'Type 1 DM with ketoacidosis' },

    // GI / Abdominal
    'K35.80': { code: '74400008',  display: 'Appendicitis (disorder)' },
    'K85.9':  { code: '75694006',  display: 'Acute pancreatitis' },
    'K92.2':  { code: '74474003',  display: 'GI hemorrhage' },
    'K57.92': { code: '235706008', display: 'Diverticulitis' },

    // Renal
    'N17.9':  { code: '14669001',  display: 'Acute kidney injury' },
    'N18.6':  { code: '46177005',  display: 'End stage renal disease' },
    'N39.0':  { code: '68566005',  display: 'UTI (disorder)' },

    // Symptoms & signs
    'R07.9':  { code: '29857009',  display: 'Chest pain (finding)' },
    'R10.9':  { code: '21522001',  display: 'Abdominal pain' },
    'R11.2':  { code: '422587007', display: 'Nausea and vomiting' },
    'R55':    { code: '271594007', display: 'Syncope and collapse' },
    'R56.9':  { code: '91175000',  display: 'Seizure' },

    // Trauma / Fractures
    'S72.001A':{ code: '5913000',   display: 'Fracture of neck of femur' },
    'S52.501A':{ code: '263102004', display: 'Fracture of radius' },
    'S62.001A':{ code: '65966004',  display: 'Fracture of wrist' },
    'S06.0X0A':{ code: '110030002', display: 'Concussion injury' },

    // Mental health
    'F32.9':  { code: '370143000', display: 'Major depressive disorder' },
    'F41.9':  { code: '197480006', display: 'Anxiety disorder' },
    'F10.20': { code: '7200002',   display: 'Alcohol dependence' },

    // Obstetric
    'O80':    { code: '396459000', display: 'Term delivery' },
    'O60.10X0':{ code: '6383007',  display: 'Preterm labor' },

    // Pediatric common
    'P59.9':  { code: '387732009', display: 'Neonatal jaundice' },
    'B34.9':  { code: '34014006',  display: 'Viral infection NOS' }
};

/**
 * Look up SNOMED CT equivalent for an ICD-10 code.
 * @returns {object|null} { code, display } or null if not in crosswalk
 */
function icdToSnomed(icdCode) {
    if (!icdCode) return null;
    var trimmed = ('' + icdCode).trim();
    return ICD_TO_SNOMED[trimmed] || null;
}

/**
 * Build a FHIR-style dual-coding array for a Condition resource.
 * Always includes ICD-10. Adds SNOMED if mapping exists.
 */
function buildDualCoding(icdCode, icdDisplay) {
    var coding = [{
        system: 'http://hl7.org/fhir/sid/icd-10-cm',
        code: icdCode,
        display: icdDisplay
    }];

    var snomed = icdToSnomed(icdCode);
    if (snomed) {
        coding.push({
            system: 'http://snomed.info/sct',
            code: snomed.code,
            display: snomed.display
        });
    }

    return coding;
}

/**
 * Example usage in a Mirth transformer:
 *
 *   var dx = msg['DG1']['DG1.3']['DG1.3.1'].toString();
 *   var desc = msg['DG1']['DG1.3']['DG1.3.2'].toString();
 *   var coding = buildDualCoding(dx, desc);
 *
 *   var condition = {
 *       resourceType: 'Condition',
 *       code: { coding: coding, text: desc },
 *       subject: { reference: 'Patient/' + mrn }
 *   };
 */
