# Recipe #5 — HL7v2 ORU^R01 → FHIR R4 DiagnosticReport + Observations Bundle

The most-asked transformation on Mirth forums. Maps HL7v2 lab results (ORU^R01) into a FHIR Transaction Bundle suitable for posting to any FHIR R4 server.

## What it builds

Input: HL7v2 ORU^R01 with MSH, PID, OBR, OBX (1..n) segments.

Output: FHIR Transaction Bundle containing:

| Resource | Source | Notes |
|---|---|---|
| Patient | PID-3, PID-5, PID-7, PID-8 | Tagged with US Core profile |
| ServiceRequest | OBR-2/3 (order ID), OBR-4 (LOINC) | Status: completed, intent: order |
| DiagnosticReport | OBR-7 (date), OBR-25 (status) | US Core Lab profile |
| Observation (x n) | OBX-3, OBX-5, OBX-6, OBX-7, OBX-8 | US Core Lab Observation profile |

## Code mappings applied

- **HL7 abnormal flags** → FHIR ObservationInterpretation (`L`, `H`, `LL`, `HH`, `N`, etc.)
- **HL7 result status (OBX-11)** → FHIR Observation.status (`F`→final, `P`→preliminary, `C`→corrected)
- **OBR status (OBR-25)** → FHIR DiagnosticReport.status
- **HL7 gender (PID-8)** → FHIR AdministrativeGender
- **LOINC system code (OBX-3.3)** → FHIR canonical URL `http://loinc.org`
- **Value types**: NM (numeric) → valueQuantity, CE/CWE → valueCodeableConcept, ST → valueString

## Reference range parsing

`OBX-7` is parsed for ranges in formats:
- `4.5-11.0` → `referenceRange[0].low = 4.5, high = 11.0`
- `<5.0` or `>200` → captured as `referenceRange[0].text`

## Where to install

**Source Connector → Transformer → Add Step → JavaScript** — paste [transformer.js](transformer.js).

## Test

```bash
# Use the sample data
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ORU_R01
# Expected: ACK AA, channelMap['observationCount'] = 3 (matches sample message)
```

## Customization

Edit constants at the top of `transformer.js`:

```javascript
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';  // → your MRN system OID
var US_CORE_PATIENT_PROFILE = '...';                        // → your profile
var US_CORE_LAB_OBS_PROFILE = '...';
var US_CORE_DR_PROFILE = '...';
```

## Sample input/output

See [../../sample-data/hl7v2/](../../sample-data/hl7v2/) — `ORU_R01` message from `send-test-hl7v2.py` produces 3 Observations (WBC, RBC, Hemoglobin) in a Bundle with 6 entries total (Patient + ServiceRequest + DiagnosticReport + 3 Observations).
