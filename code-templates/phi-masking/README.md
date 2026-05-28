# Recipe #31 — PHI Masking Code Template

> Centralized HIPAA-aware masking helpers. One library, three signatures, gated by `configurationMap` so the same channels can ship to dev/staging/prod without code changes.

## What this recipe gives you

A Mirth **Code Template** library with three public functions:

| Function | Use it from | What it does |
|---|---|---|
| `maskPHI(text)` | logs, error handlers, alert bodies | regex-mask SSN / DOB / phone / email in any string |
| `maskHL7Segment(seg, type)` | source filter / transformer | field-aware masking of PID, NK1, GT1, IN1, OBX |
| `maskFHIRResource(json)` | FHIR destination / response transformer | object-aware masking of Patient / Practitioner / Coverage / Observation |

All three short-circuit when `configurationMap['phi.masking.enabled']` is not `true`, so you wire them in once and toggle at deploy time.

## Why

- HIPAA § 164.514 Safe Harbor lists 18 identifiers that must be removed for a dataset to be considered de-identified. The patterns this template handles cover SSN, DOB precision, phone, email, ZIP > 3 digits, names, and MRN — the 6 most common.
- The biggest PHI leak source on Mirth deployments is the **server log** (`logger.info` of the raw message during dev). Calling `logger.info(maskPHI(msg))` makes leakage-by-debug-print structurally impossible.
- Disabling masking in production (where logs may already live in a HIPAA-compliant SIEM and you want full message replay) is a single configurationMap flip.

## Where the file goes

```
code-templates/phi-masking/
├── README.md            <-- this file
└── code-template.js     <-- copy this into a Mirth Code Template
```

## Install

1. Open Mirth Connect Administrator -> **Code Templates** -> right-click -> **New Library** -> name it `Security`.
2. Set the library to be available in **all channels** (or scope to just those that need it).
3. Add a new **Code Template** -> Name: `PHI Masking` -> Type: `Function` -> Context: `Message`.
4. Paste the contents of `code-template.js`.
5. **Save Changes**.

## Configuration

Mirth Connect Administrator -> **Server Settings -> Configuration Map**:

| Key | Example value | Default | Notes |
|---|---|---|---|
| `phi.masking.enabled` | `true` / `false` | `false` (off) | master toggle |
| `phi.masking.profile` | `partial` / `full` | `partial` | `partial` keeps last-4 of SSN/MRN; `full` redacts entirely |

Recommended deploy matrix:

| Environment | enabled | profile | Why |
|---|---|---|---|
| dev | `true`  | `full`    | developers should never see real PHI on their laptops |
| staging | `true` | `partial` | testers can correlate by last-4 |
| prod | `false` | n/a | full fidelity needed for actual interfaces; logs live in HIPAA SIEM |

> **Best practice:** call `maskPHI()` everywhere you call `logger.info(...)`. If production prod *also* needs masked logs (e.g. sending logs to Loki — see Recipe #37 — where the index isn't a covered SIEM), flip `phi.masking.enabled=true` in prod too.

## Usage examples

### In a transformer or filter

```javascript
// Mask a single segment
var pid = $('PID');
var masked = maskHL7Segment(pid.toString(), 'PID');
logger.info('Processing patient: ' + masked);

// Mask the full message for debug
logger.debug('Raw HL7:\n' + maskPHI(connectorMessage.getRawData()));

// Mask a FHIR resource before posting elsewhere for analytics
var fhirOut = maskFHIRResource(JSON.parse(msg));
channelMap.put('analytics_payload', JSON.stringify(fhirOut));
```

### In an error handler (Recipe #38 friendly)

```javascript
try {
    // ... transform ...
} catch (e) {
    logger.error('Failed: ' + e.message + ' | sample=' + maskPHI(connectorMessage.getRawData().substring(0, 500)));
    throw e;
}
```

### In a Slack alert body

```javascript
var alertBody = 'Channel failed for patient ' + maskHL7Segment($('PID').toString(), 'PID');
httpPost(SLACK_WEBHOOK, JSON.stringify({ text: alertBody }), { 'Content-Type': 'application/json' });
```

## Test it (verified)

Run from the repo root — exercises every public function with `configurationMap` stubbed:

```bash
node -e "
global.configurationMap = { get: function(k){
  if (k === 'phi.masking.enabled') return 'true';
  if (k === 'phi.masking.profile') return 'partial';
  return null;
}};
var m = require('./code-templates/phi-masking/code-template.js');
console.log('SSN  :', m.maskPHI('SSN 123-45-6789 on file'));
console.log('DOB  :', m.maskPHI('born 1985-07-12'));
console.log('Phone:', m.maskPHI('call 415-555-1234'));
console.log('Email:', m.maskPHI('jane.doe@example.com'));
var pid = 'PID|1||MRN1234567^^^HOSP^MR||DOE^JANE||19850712|F|||123 MAIN ST^^SF^CA^94103||415-555-1234';
console.log('PID  :', m.maskHL7Segment(pid, 'PID'));
"
```

Expected output:
```
SSN  : SSN XXX-XX-6789 on file
DOB  : born 1985-XX-XX
Phone: call ###-###-####
Email: j***@example.com
PID  : PID|1||******4567^^^HOSP^MR||REDACTED^REDACTED||1985XXXX|F|||REDACTED^^SF^CA^941XX||###-###-####
```

## Customize

- **Add a new identifier type** — e.g. medical device serials: drop a `_maskSerial()` helper next to `_maskMRN()` and call it inside the segments where it appears.
- **Per-channel allow-list** — wrap the wrappers so a channel can opt out: `if (channelMap.get('skip_masking') === 'true') return text;`
- **Cryptographic pseudonymization** — replace the regex mask with HMAC-SHA256 keyed by a secret from Vault (see Recipe #33). That lets you join records across systems without revealing the original ID.
- **Locale variants** — the phone regex assumes North American 10-digit format. For E.164 add `\+\d{8,15}` patterns.

## Tested on

- Mirth Connect 4.5.2 (Rhino JavaScript engine)
- Standalone verification on Node.js 22.x for the regex logic

## Author / License

Author: Nirmitee.io
License: MIT
