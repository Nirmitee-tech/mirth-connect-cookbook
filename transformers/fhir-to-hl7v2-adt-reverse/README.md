# Recipe #15 — FHIR R4 Bundle -> HL7v2 ADT^A01 (Reverse Mapping)

The integration most teams hit when they say "our new EHR is FHIR-native but the lab / pharmacy / billing system only accepts HL7v2." This transformer accepts a FHIR Transaction Bundle on an HTTP Listener, builds a fully-framed ADT^A01 message string, and hands it to a TCP Sender for MLLP delivery.

## What it builds

Input: FHIR R4 Bundle JSON containing at minimum:
- `Patient` (required)
- `Encounter` (recommended -- drives PV1)
- `Coverage` (optional -- drives IN1)
- `Practitioner` (optional -- attending in PV1-7)
- `Location` (optional -- PV1-3)

Output: HL7v2 ADT message string, segments delimited with `\r`, ready for MLLP framing by Mirth's TCP Sender.

| FHIR | HL7v2 |
|---|---|
| Bundle (envelope) | MSH (generated MSH-7 timestamp, MSH-10 control ID) |
| Patient.identifier, name, gender, birthDate, address, telecom, maritalStatus | PID-3, PID-5, PID-7, PID-8, PID-11, PID-13, PID-16 |
| Patient.extension us-core-race / us-core-ethnicity | PID-10, PID-22 |
| Encounter.class.code (ActCode) | PV1-2 patient class |
| Encounter.location[0] -> Location | PV1-3 assigned location |
| Encounter.participant (ATND) -> Practitioner | PV1-7 attending doctor |
| Encounter.identifier | PV1-19 visit number |
| Encounter.period.start / end | PV1-44 / PV1-45 |
| Coverage.payor + Coverage.class | IN1-4 / IN1-2 |
| Coverage.subscriberId | IN1-8, IN1-17 |

## Code mappings applied

Encounter.class.code (HL7 v3 ActCode) -> PV1-2 Patient Class:

| ActCode | PV1-2 |
|---|---|
| AMB (ambulatory) | O |
| IMP (inpatient) | I |
| EMER (emergency) | E |
| OBSENC (observation) | B |
| PRENC (pre-admission) | P |
| SS (short stay) | R |

Patient.gender -> PID-8: `male`->M, `female`->F, `other`->O, `unknown`->U.

ISO 8601 timestamps -> HL7v2 `yyyyMMddHHmmss` (UTC). Timezone offsets are stripped.

## Trigger event

Defaults to `A01` (admit/visit notification). Override per message via `channelMap.put('triggerEvent', 'A03')` from the source preprocessor for discharges, A04 for registrations, A08 for updates, etc. The transformer reads `channelMap.get('triggerEvent')` first, falls back to the `DEFAULT_TRIGGER` constant.

## Where to install

| Where | What |
|---|---|
| **Source Connector: HTTP Listener** | Inbound message type `JSON`. Path e.g. `/fhir-to-hl7`. Method `POST`. |
| **Source Transformer** | Add Step -> JavaScript -> paste [transformer.js](transformer.js). |
| **Destination: TCP Sender** | MLLP framing (start `0x0B`, end `0x1C 0x0D`). Template = `${hl7v2Message}` (or `${tmp}`). |

The transformer assigns the HL7v2 string to `tmp` (the outbound message body) and also publishes it via `channelMap.put('hl7v2Message', ...)` so downstream destinations can pick it up by name.

## Configuration

Edit the constants block at the top:

```javascript
var SENDING_APP        = 'NIRMITEE-FHIR';
var SENDING_FACILITY   = 'NIRMITEE';
var RECEIVING_APP      = 'LEGACY-HIS';
var RECEIVING_FACILITY = 'HOSPITAL';
var HL7_VERSION        = '2.5.1';
var PROCESSING_ID      = 'P';
var DEFAULT_TRIGGER    = 'A01';
```

## Channel map outputs

| Key | Description |
|---|---|
| `hl7v2Message` | Full HL7v2 message string |
| `messageControlId` | MSH-10 value |
| `triggerEvent` | A01 / A03 / A04 etc. |
| `patientMrn` | Resolved MRN |
| `encounterId` | Resolved visit number |

## Missing-field handling

- No `Patient.name` with `use=official` -> falls back to the first name entry.
- No identifiers on Patient -> PID-3 emitted with empty value (downstream may reject; this is by design so the failure is loud).
- No `Encounter` -> PV1 still emitted with `class=U` and empty location/doctor. Most legacy systems accept this for A28/A29 (patient record only).
- No `Coverage` -> IN1 is omitted entirely (not emitted as empty).

Missing `Patient` is a hard error -- the transformer throws so Mirth records a clear failure rather than emitting malformed HL7.

## Test method

```bash
node /tmp/test-fhir-adt.cjs   # see README for the script
```

Verified output from a full bundle (Patient + Practitioner + Location + Encounter + Coverage):

```
MSH|^~\&|NIRMITEE-FHIR|NIRMITEE|LEGACY-HIS|HOSPITAL|20260528063932||ADT^A01^ADT_A01|MSG111111112222333344|P|2.5.1
PID|1||MRN-12345^^^NIRMITEE^MR||Smith^John Q||19800512|M|||123 Main St^^Boston^MA^02118^US||617-555-1234|||M||pat-1||||
PV1|1|I|ICU-3A^^^loc-1||||1234567890^Welby^Marcus||||||||||||VISIT-9001|||||||||||||||||||||||||20260528083000|
IN1|1|PLAN-A||Blue Cross||||SUB-1111|||||||||SUB-1111
```

Minimal bundle (just Patient) still produces a 3-segment MSH+PID+PV1 result.

## Customization

- **Different trigger events**: drive `triggerEvent` from `Encounter.status` (`finished` -> A03 discharge, `cancelled` -> A11, etc.) in a source preprocessor.
- **More segments**: add NK1 from Patient.contact, GT1 from Account.guarantor, OBX from Observation, AL1 from AllergyIntolerance.
- **Localization**: ensure your downstream system's character encoding matches MSH-18 (set explicitly if non-ASCII names are in play).

## Tested on

Mirth Connect 4.5.2; sample bundle validated against Hapi FHIR R4 schema.

Author: Nirmitee.io | License: MIT
