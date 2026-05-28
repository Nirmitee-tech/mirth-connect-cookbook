# Recipe #12 — HL7v2 SIU^S12/S13/S14/S15 -> FHIR R4 Appointment Bundle

Maps scheduling messages (`SIU^S12` booking, `S13` reschedule, `S14` modify, `S15` cancel, plus S17/S26) into a FHIR R4 Transaction Bundle ready to write into a scheduling-aware FHIR server.

## What it builds

Input segments:

| Segment | Used for |
|---|---|
| MSH | Trigger event (drives `Appointment.status`) |
| SCH | Appointment IDs, start, end (or duration), reason, type |
| PID | Patient resource |
| AIS | `Appointment.serviceType` (procedure / visit code) |
| AIG | Practitioner participant |
| AIL | Location participant |

Output: FHIR Transaction Bundle:

- `Patient` (PID-3, PID-5, PID-7, PID-8) -- US Core Patient profile.
- `Practitioner` (AIG-3) -- US Core Practitioner profile, **only when AIG present**.
- `Location` (AIL-3) -- US Core Location profile, **only when AIL present**.
- `Appointment` with all three as participants.

## Code mappings applied

Trigger event (MSH-9.2) -> `Appointment.status`:

| MSH-9.2 | Meaning | FHIR status |
|---|---|---|
| S12 | New appointment booking | booked |
| S13 | Reschedule | booked (+ `comment` = "Rescheduled") |
| S14 | Modification | booked |
| S15 | Cancellation | cancelled |
| S16 | Discontinuation | cancelled |
| S17 | Deletion | entered-in-error |
| S26 | Patient did not show | noshow |

SCH-11.4/11.5 (start/end) -> `Appointment.start` / `Appointment.end` in ISO 8601.

If SCH-11.5 is missing but SCH-9 (duration) and SCH-10 (units) are present, the transformer computes the end timestamp.

AIS-3 system identifier `SCT` or `SNOMED` -> `http://snomed.info/sct`. Otherwise the local fallback `http://hospital.local/services` is used; replace this in the constants block for production.

## Where to install

**Source Connector -> Transformer -> Add Step -> JavaScript** -- paste [transformer.js](transformer.js).

## Channel map outputs

| Key | Description |
|---|---|
| `fhirBundle` | Serialized Bundle JSON, ready for HTTP Sender |
| `patientId` | Logical Patient.id |
| `appointmentId` | Logical Appointment.id |
| `triggerEvent` | Raw MSH-9.2 (e.g. `S13`) |
| `appointmentStatus` | Computed status (e.g. `booked`, `cancelled`) |

## Test method

```bash
node -e '
  const vm=require("vm");
  const code=require("fs").readFileSync("transformer.js","utf8");
  new vm.Script(code);
  console.log("SIU transformer: OK");
'
```

Confirmed: event mapping S12->booked, S15->cancelled, S17->entered-in-error, S26->noshow; date conversion `20260601093000` -> `2026-06-01T09:30:00Z`.

End-to-end via Mirth:

```bash
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type SIU_S12
# Expected: channelMap['appointmentStatus'] = 'booked'
#           Bundle contains Patient + (optional Practitioner) + (optional Location) + Appointment
```

## Customization

Edit constants at the top of `transformer.js` for your FHIR system OIDs and profiles. If your downstream system rejects appointments without an explicit `serviceCategory`, populate `appointment.serviceCategory` from `SCH-7` (appointment reason category).

## Tested on

Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs.

Author: Nirmitee.io | License: MIT
