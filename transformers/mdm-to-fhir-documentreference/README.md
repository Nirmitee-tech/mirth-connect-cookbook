# Recipe #13 — HL7v2 MDM^T02/T04/T08 -> FHIR R4 DocumentReference + Binary Bundle

Maps Medical Document Management messages (clinical notes, discharge summaries, transcribed reports) into a FHIR R4 Transaction Bundle that pushes both metadata (`DocumentReference`) and content (`Binary`) into any FHIR server.

## What it builds

Input segments:

| Segment | Used for |
|---|---|
| MSH | Trigger event (T02 / T04 / T08) |
| PID | Patient |
| TXA | Document metadata (type, status, dates, doc ID, author) |
| OBX (1..n) | Document content -- types `TX`, `FT`, `ST`, or `ED` |

Output: FHIR Transaction Bundle:

- `Patient` (PID-3, PID-5, PID-7, PID-8).
- `Binary` -- concatenated OBX content, base64-encoded.
- `DocumentReference` referencing the `Binary` via `content.attachment.url`.

## Code mappings applied

Trigger event (MSH-9.2):

| Event | Meaning | `DocumentReference.status` | `DocumentReference.docStatus` |
|---|---|---|---|
| T02 | Original document notification + content | current | final |
| T04 | Document edit notification (replaces previous) | current | preliminary |
| T08 | Document edit notification | current | final (+ `relatesTo.code = replaces`) |

TXA-17 (Document Completion Status) overrides `docStatus` when set:

| TXA-17 | FHIR docStatus |
|---|---|
| DI (Dictated) | preliminary |
| DO (Documented) | preliminary |
| IP (In Progress) | preliminary |
| AU (Authenticated) | final |
| LA (Legally Authenticated) | amended |
| PA (Pre-authenticated) | preliminary |
| CA (Cancelled) | entered-in-error |

TXA-2 (Document Type) -> `DocumentReference.type` (`http://loinc.org` codes recommended).
TXA-13 (Confidentiality) -> `DocumentReference.securityLabel` using `http://terminology.hl7.org/CodeSystem/v3-Confidentiality`.

## OBX content handling

| OBX-2 | Treatment |
|---|---|
| TX, FT, ST | Concatenated with newline separators, then base64-encoded into `Binary.data`. `contentType` = `text/plain; charset=utf-8`. |
| ED | OBX-5.5 already contains base64 bytes -- pass-through. `contentType` = `application/octet-stream` (or whatever OBX-5.3 declares). |

HL7 escape sequences (`\.br\`, `\X0D\`, `\F\`, `\S\`, `\T\`, `\R\`, `\E\`) are translated back to their literal characters before encoding.

## Where to install

**Source Connector -> Transformer -> Add Step -> JavaScript** -- paste [transformer.js](transformer.js).

## Channel map outputs

| Key | Description |
|---|---|
| `fhirBundle` | Serialized Bundle JSON, ready for HTTP Sender |
| `patientId` | Logical Patient.id |
| `documentReferenceId` | Logical DocumentReference.id |
| `binaryId` | Logical Binary.id |
| `triggerEvent` | Raw MSH-9.2 (`T02`, `T04`, `T08`) |
| `docStatus`, `refStatus` | Computed FHIR statuses |
| `obxSegmentsConsumed` | Number of OBX segments that contributed content |

## Test method

```bash
node -e '
  const vm=require("vm");
  const code=require("fs").readFileSync("transformer.js","utf8");
  new vm.Script(code);
  console.log("MDM transformer: OK");
'
```

Confirmed: syntax OK; `base64Encode("Hello")` -> `SGVsbG8=`; event mapping T02->final/current, T04->preliminary/current, T08->final/current; TXA-17 AU->final, CA->entered-in-error.

End-to-end via Mirth:

```bash
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type MDM_T02
# Expected: Bundle has 3 entries (Patient + Binary + DocumentReference)
#           channelMap['docStatus'] = 'final'
#           channelMap['obxSegmentsConsumed'] matches sample message
```

## Customization

- **Different content code system**: replace `http://loinc.org` in `documentReference.type.coding[0].system` with your local code system (e.g. SNOMED CT, IHE XDS class codes).
- **External document storage**: post the OBX content to an object store first (S3, Azure Blob), then replace `Binary` with an `attachment.url` pointing at the signed URL.
- **PDF documents**: when ED segments carry PDF, set `contentType = 'application/pdf'` based on OBX-5.3.

## Tested on

Mirth Connect 4.5.2 with HL7 v2.5.1 / v2.5 inputs.

Author: Nirmitee.io | License: MIT
