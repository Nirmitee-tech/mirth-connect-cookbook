# DICOM C-STORE → FHIR R4 ImagingStudy

Receives a DICOM C-STORE association on Mirth's built-in DICOM Listener, extracts structured metadata, uploads the raw pixel-data file to S3/MinIO, and emits a FHIR R4 `ImagingStudy` resource pointing at the object-store URL.

```
    [CT/MR/US modality]
            │
            │ DICOM C-STORE (port 11112)
            ▼
   ┌──────────────────────┐
   │ Mirth DICOM Listener │
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Transformer (this)  │  ← parses tags, builds ImagingStudy JSON
   └──────────┬───────────┘
              │
        ┌─────┴────────┐
        ▼              ▼
  [S3/MinIO PUT]   [FHIR POST ImagingStudy]
   raw .dcm file    structured metadata
```

## What it extracts

Default tag list (override via `dicom.extract.tags` in configurationMap):

| Tag | Name | Used as |
|---|---|---|
| `00100010` | PatientName | `ImagingStudy.subject.display` (optional) |
| `00100020` | PatientID | `ImagingStudy.subject.reference` |
| `00100030` | PatientBirthDate | (informational) |
| `00100040` | PatientSex | (informational) |
| `0020000D` | StudyInstanceUID | `ImagingStudy.identifier[urn:dicom:uid]` |
| `0020000E` | SeriesInstanceUID | `ImagingStudy.series.uid` |
| `00080018` | SOPInstanceUID | `ImagingStudy.series.instance.uid` |
| `00080020` | StudyDate | combined with `StudyTime` → `started` |
| `00080030` | StudyTime | combined with `StudyDate` → `started` |
| `00080050` | AccessionNumber | second `identifier` |
| `00080060` | Modality | `ImagingStudy.modality` + `series.modality` |
| `00081030` | StudyDescription | `ImagingStudy.description` |
| `0008103E` | SeriesDescription | `ImagingStudy.series.description` |
| `00180015` | BodyPartExamined | `ImagingStudy.series.bodySite.display` |
| `00080090` | ReferringPhysician | `ImagingStudy.referrer.display` |
| `00200010..13` | Study/Series/Instance Numbers | series/instance `number` |

All accessors are `try`/`catch`-wrapped — missing tags become `null` and are pruned from the output JSON (FHIR doesn't allow most explicit nulls).

## Where to install

1. **Channel → Source → Connector type:** DICOM Listener
2. Configure:
   - **Listener address:** `0.0.0.0`
   - **Listener port:** `11112`
   - **AE Title:** `MIRTH` (whatever your modality is configured to push to)
   - **Accept-Storage SOP Classes:** check CT (`1.2.840.10008.5.1.4.1.1.2`), MR (`1.2.840.10008.5.1.4.1.1.4`), US (`1.2.840.10008.5.1.4.1.1.6.1`), etc.
   - **TLS:** off for dev, on (with cert pair) for production
3. **Channel → Source → Transformer:** paste [transformer.js](transformer.js).
4. **Channel → Destinations:**
   - **Destination 1 — HTTP Sender (raw pixel data to S3/MinIO):**
     - URL: `${s3PutUrl}`
     - Method: PUT
     - Content-Type: `application/dicom`
     - Body type: raw, value: `${message.encodedData}` (or `${message.rawData}` if using base64 directly)
   - **Destination 2 — HTTP Sender (FHIR POST):**
     - URL: `${fhir.base.url}/ImagingStudy`
     - Method: POST
     - Headers: `Content-Type: application/fhir+json`
     - Body: `${fhirImagingStudy}`
5. **Settings → Configuration Map:**

   | Key | Default | Purpose |
   |---|---|---|
   | `dicom.s3.endpoint` | `http://minio:9000` | S3 / MinIO endpoint |
   | `dicom.s3.bucket` | `dicom-raw` | Bucket name |
   | `fhir.base.url` | `http://localhost:8089/fhir` | FHIR server base URL |
   | `dicom.extract.tags` | (default list above) | Comma-separated hex tags |

6. Deploy.

## S3 / MinIO auth

The transformer only builds the *URL*. Authentication (AWS SigV4, MinIO access key, or presigned URLs) is handled by the HTTP Sender destination. Two common patterns:

- **MinIO with static credentials**: set `Authorization: AWS4-HMAC-SHA256 ...` headers via a destination preprocessor that signs the request (see `code-templates/aws-sigv4-signer/`).
- **Presigned URLs**: have an external service generate a presigned PUT URL per study; the transformer fetches it and overwrites `channelMap.s3PutUrl`.

## Test

```bash
# 1. Bring up a local MinIO + FHIR server
docker compose up -d minio hapi-fhir
docker exec mirth-minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker exec mirth-minio mc mb local/dicom-raw

# 2. Use dcm4che's storescu to push a test DICOM file to Mirth.
#    Install dcm4che tools:
#    brew install dcm4che    (macOS)
#    apt install dcm4che     (Linux)
#
storescu --bind STORESCU --connect MIRTH@localhost:11112 \
    sample-data/dicom/CT-chest-001.dcm

# 3. In Mirth Administrator → Dashboard, expect 1 message received, 2 SENT.

# 4. Verify the S3 object landed:
docker exec mirth-minio mc ls local/dicom-raw/studies --recursive

#   Expected: studies/<StudyInstanceUID>/<SOPInstanceUID>.dcm

# 5. Verify the FHIR resource:
curl -s 'http://localhost:8080/fhir/ImagingStudy?identifier=urn:dicom:uid|<StudyInstanceUID>' | jq .

#   Expected: Bundle with one ImagingStudy whose series[0].endpoint[0].display
#   points to the MinIO URL.

# 6. Error path — push a DICOM file with a stripped StudyInstanceUID:
dcmodify -e StudyInstanceUID sample-data/dicom/CT-chest-001.dcm -o /tmp/bad.dcm
storescu --bind STORESCU --connect MIRTH@localhost:11112 /tmp/bad.dcm
#   Expected: channel error "DICOM dataset missing required UIDs",
#   message goes to Mirth's queued/errored bucket, no S3 write.
```

## Customize

- **Per-modality routing**: read `channelMap.get('dicomSummary')` modality field in a Channel Router destination; fan-out by modality.
- **Extra tags**: append your hex tag to `dicom.extract.tags`. Tag values appear in `channelMap.dicomExtractedTags`.
- **WSI / large studies**: split per-instance instead of per-study. Each C-STORE association in a study is a separate Mirth message; the destination FHIR server merges them by `Bundle.transaction` with `If-None-Exist` matching on `identifier=urn:dicom:uid|<StudyUID>`.
- **DICOMweb instead of FHIR**: replace destination 2 with STOW-RS (`POST /studies` Content-Type `application/dicom+json`). The same metadata extraction applies — only the destination payload format changes.
- **Body-part SNOMED mapping**: pair with `transformers/icd10-to-snomed-crosswalk/` style table for `BodyPartExamined` → SNOMED bodyStructure codes.

## Production considerations

- **DICOM message size**: a single CT slice is ~500 KB, a study can be 2 GB. Set Mirth's `mcserver.vmoptions` `-Xmx` to >= 4 GB. Avoid `JSON.stringify` of pixel data — we only stringify the metadata.
- **Idempotency**: S3 keys are deterministic (`studies/<StudyUID>/<SOPUID>.dcm`). Re-pushing the same instance overwrites the same object — safe. The FHIR POST should use `PUT /ImagingStudy?identifier=urn:dicom:uid|<StudyUID>` (conditional update) instead of POST for the same reason.
- **TLS**: production DICOM associations should use TLS-1.2+. Mirth's DICOM Listener supports TLS — generate a keypair, set the listener's `tls.enabled=true` and `tls.keystore=...`.
- **AE Title whitelist**: Mirth's DICOM Listener accepts any calling AE by default. In production, restrict via the Listener's "Accept calling AE" list.
- **Backpressure**: a CT scanner can push 200 instances in 90 seconds. Set Mirth's source queue to "Always queue" so the network doesn't drop associations while downstream is catching up.

## Files

- [transformer.js](transformer.js) — DICOM parser + ImagingStudy builder
