# HL7v2 ADT → FHIR R4 Transaction Bundle

Production-grade transformer that converts an HL7v2 ADT^A01 admission message into a FHIR R4 Transaction Bundle with 6-9 resources, mapping tables, and a business rules engine.

## What it does

Input: HL7v2 ADT^A01 with MSH, EVN, PID, PV1, IN1, DG1, NK1 segments.

Output: FHIR R4 Transaction Bundle containing:
- Patient (US Core profile)
- Organization (from facility lookup with NPI)
- Practitioner (from PV1.7 attending)
- Encounter (with class, type, location, service type)
- Condition (with dual ICD-10 + SNOMED CT coding) — if DG1 present
- Coverage (payer + plan) — if IN1 present
- Flag resources (per triggered business rule)

## Mapping tables

- `FACILITY_MAP` — sending facility → Organization name + NPI
- `WARD_SERVICE_MAP` — ward code → specialty + SNOMED code
- `PAYER_MAP` — insurance code → payer name + plan type
- `CRITICAL_DX` — ICD-10 prefix → clinical alert + team
- `ICD_TO_SNOMED` — ICD-10 → SNOMED CT (see [icd10-to-snomed-crosswalk](../icd10-to-snomed-crosswalk/))
- `MARITAL_MAP`, `genderMap`, `classMap`, `admitTypeMap`

## Business rules

Triggered automatically by the transformer:

| Rule | Condition | Action |
|---|---|---|
| Sepsis SEP-1 bundle | DG1 starts with A41 | Add Flag, log SEP-1 timer notification |
| Geriatric screening | Age ≥ 65 + inpatient | Add Flag, auto-order geriatric consult |
| ICU admission | Ward contains 'ICU' or 'CCU' | Add Flag, notify pharmacy + bed management |
| Insurance missing | No IN1 segment | Add Flag, financial counseling referral |
| Hip fracture elderly | DG1 starts with S72 + age ≥ 65 | STAT alert: target OR within 24h |

## How to use

1. Import `../../channels/hl7v2-to-fhir-bundle/channel.xml` into Mirth Administrator
2. Set channel port (default 6661)
3. Deploy
4. Send a test message:
   ```bash
   python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01
   ```

The transformer code is in [transformer.js](transformer.js).

## Sample input/output

See [../../sample-data/hl7v2/adt-a01-sepsis-icu.hl7](../../sample-data/hl7v2/adt-a01-sepsis-icu.hl7) for input.

Expected output is stored in `channelMap.get('fhirBundle')` as JSON. The channel writer destination logs it.

## Customization

Edit the mapping tables at the top of [transformer.js](transformer.js) for your environment:
- Add your facility codes and NPIs
- Add your local ward codes
- Add your insurance payers
- Extend `CRITICAL_DX` with your protocols

## Production considerations

- **Cache mapping tables in `globalChannelMap`** if they exceed 50 entries — avoid re-parsing on every message
- **Validate against US Core profiles** before sending downstream (see [code-templates/fhir-validator/](../../code-templates/fhir-validator/))
- **Add monitoring** — emit metrics for resources/message, alerts fired, flags raised
- **Pair with [tx-server-validation](../tx-server-validation/)** for live code validation
