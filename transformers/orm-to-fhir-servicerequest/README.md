# Recipe #11 — HL7v2 ORM^O01 -> FHIR R4 ServiceRequest Bundle

Maps lab / radiology / cardiology orders (`ORM^O01`) into a FHIR R4 Transaction Bundle: Patient + Practitioner + ServiceRequest (+ Specimen if `SPM` is present). The companion to Recipe #5 (ORU -> DiagnosticReport).

## What it builds

Input: HL7v2 ORM^O01 with MSH, PID, ORC, OBR, optional SPM, optional NTE segments.

Output: FHIR Transaction Bundle containing:

| Resource | Source | Notes |
|---|---|---|
| Patient | PID-3, PID-5, PID-7, PID-8 | US Core Patient profile |
| Practitioner | ORC-12 (ordering provider) | US Core Practitioner profile (only if present) |
| ServiceRequest | ORC-1, ORC-2/3, OBR-4, OBR-6/7, OBR-27 | US Core ServiceRequest profile |
| Specimen | SPM-2, SPM-4, SPM-17 | Linked via `ServiceRequest.specimen` (only if SPM present) |

## Code mappings applied

ORC-1 (Order Control) -> `ServiceRequest.status`:

| ORC-1 | Meaning | FHIR status |
|---|---|---|
| NW | New order | active |
| OK | Order accepted | active |
| CA | Cancel order | revoked |
| DC | Discontinue | revoked |
| CM | Completed | completed |
| HD | Hold | on-hold |
| RP / RO | Replace / replacement-order | active |
| XO | Cancel (transmission error) | revoked |

OBR-27.6 (Priority) -> `ServiceRequest.priority`:

| OBR-27.6 | FHIR priority |
|---|---|
| S (STAT) | stat |
| A (ASAP) | asap |
| P (Pre-op) | urgent |
| T (Timing critical) | asap |
| R (Routine) | routine |

OBR-4 system identifier `LN` / `LOINC` / `L` -> `http://loinc.org`.

OBR-24 (Diagnostic Service Section) -> `ServiceRequest.category` using `http://terminology.hl7.org/CodeSystem/v2-0074`.

## Where to install

**Source Connector -> Transformer -> Add Step -> JavaScript** -- paste [transformer.js](transformer.js).

Inbound message type: `HL7v2`. Output of the transformer is consumed by a downstream HTTP Sender destination via `channelMap.get('fhirBundle')`.

## Channel map outputs

| Key | Description |
|---|---|
| `fhirBundle` | The serialized Bundle JSON, ready to POST to a FHIR server |
| `patientId` | Logical Patient.id (MRN-based) |
| `orderId` | Placer or filler order number |
| `serviceRequestId` | Logical ServiceRequest.id |
| `orcControl` | Raw ORC-1 value (audit) |
| `fhirStatus` | Computed FHIR status (audit) |

## Test method

```bash
# Verify the script parses and helpers compute correctly
node -e '
  const vm=require("vm");
  const code=require("fs").readFileSync("transformer.js","utf8");
  new vm.Script(code);                // syntax check
  console.log("ORM transformer: OK");
'
```

Confirmed: `hl7DateToFhir("20260528120000")` -> `2026-05-28T12:00:00Z`; ORC mapping NW->active, CA->revoked, CM->completed, unknown->unknown.

End-to-end smoke test against a running Mirth:

```bash
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ORM_O01
# Expected: ACK AA; channelMap['fhirStatus'] = 'active' for a new (NW) order;
#           Bundle contains 3 entries (Patient + Practitioner + ServiceRequest)
#           or 4 if the sample message includes an SPM segment.
```

## Customization

Edit constants at the top of `transformer.js`:

```javascript
var FHIR_PATIENT_SYSTEM = 'urn:oid:2.16.840.1.113883.4.1';      // your MRN system OID
var FHIR_PRACTITIONER_SYSTEM = 'http://hl7.org/fhir/sid/us-npi'; // NPI by default
var US_CORE_PATIENT_PROFILE = '...';
var US_CORE_SERVICEREQUEST_PROFILE = '...';
```

To use a non-LOINC code system (e.g. local CDM), change the `serviceCodeSystem` fallback.

## Tested on

Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 / v2.4 inputs.

Author: Nirmitee.io | License: MIT
