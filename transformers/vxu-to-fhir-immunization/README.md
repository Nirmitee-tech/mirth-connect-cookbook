# Recipe #14 — HL7v2 VXU^V04 -> FHIR R4 Immunization Bundle

Maps Immunization Update messages (`VXU^V04`) into a FHIR R4 Transaction Bundle. Produces one `Immunization` resource per `RXA` segment, with route/site from `RXR` and education / reaction details from trailing `OBX` segments.

## What it builds

Input: HL7v2 VXU^V04 with MSH, PID, ORC, RXA, RXR?, OBX*. Multiple RXA segments per message are supported.

Output: FHIR Transaction Bundle:

- `Patient` (PID).
- `Immunization` x N, one per RXA, US Core Immunization profile.

## Code mappings applied

RXA-5 vaccine code:

| Source system code | FHIR system URL |
|---|---|
| CVX / HL70292 | `http://hl7.org/fhir/sid/cvx` |
| (anything else) | `http://hospital.local/vaccines` (replace in config) |

RXA-17 manufacturer:

| Source | FHIR |
|---|---|
| MVX code | `Immunization.manufacturer.identifier` with system `http://hl7.org/fhir/sid/mvx` |

RXA-20 (Completion Status) -> `Immunization.status`:

| RXA-20 | FHIR status |
|---|---|
| CP (Complete) | completed |
| PA (Partial) | completed |
| RE (Refused) | not-done |
| NA (Not Administered) | not-done |

RXA-21 (Action Code) `D` (delete) flips `primarySource = false`.

OBX inside the immunization block:

| OBX-3 code | Treatment |
|---|---|
| 69764-9, 30956-7, 29768-9 (VIS-related LOINC) | Appended to `Immunization.education[]` |
| 31044-1 or any code with name containing "reaction" | Appended to `Immunization.reaction[]` |

RXR-1 -> `Immunization.route` (using `http://terminology.hl7.org/CodeSystem/v3-RouteOfAdministration`).
RXR-2 -> `Immunization.site` (using `http://terminology.hl7.org/CodeSystem/v3-ActSite`).

## OBX -> RXA association

When a message contains multiple RXA blocks, OBX-4 (Observation Sub-ID) is treated as a 1-based parent-RXA index. If OBX-4 is blank and there is only one RXA, all OBX segments belong to it; otherwise unattached OBX is skipped. This matches the CDC VXU implementation guide.

## Where to install

**Source Connector -> Transformer -> Add Step -> JavaScript** -- paste [transformer.js](transformer.js).

## Channel map outputs

| Key | Description |
|---|---|
| `fhirBundle` | Serialized Bundle JSON, ready for HTTP Sender |
| `patientId` | Logical Patient.id |
| `immunizationCount` | Count of Immunization resources produced |

## Test method

```bash
node -e '
  const vm=require("vm");
  const code=require("fs").readFileSync("transformer.js","utf8");
  new vm.Script(code);
  console.log("VXU transformer: OK");
'
```

Confirmed: syntax OK; completion-status mapping `CP/PA -> completed`, `RE/NA -> not-done`; date conversion `20260301` -> `2026-03-01`, `20260301120000` -> `2026-03-01T12:00:00Z`.

End-to-end via Mirth:

```bash
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type VXU_V04
# Expected: ACK AA; channelMap['immunizationCount'] matches RXA count in sample.
```

## Customization

Edit constants at the top of `transformer.js`:

```javascript
var CVX_SYSTEM = 'http://hl7.org/fhir/sid/cvx';
var MVX_SYSTEM = 'http://hl7.org/fhir/sid/mvx';
var US_CORE_IMMUNIZATION_PROFILE = '...';   // swap for IIS / IHE profile
```

For IIS submission, you may want to flip `primarySource = false` whenever RXA-9 (Administration Notes) indicates this is a historical record rather than the immunizing provider's own write.

## Tested on

Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs.

Author: Nirmitee.io | License: MIT
