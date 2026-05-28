# Recipe #3 — HL7v2 ACK Customizer (AA/AE/AR with ERR segments)

Generate conformant HL7v2 ACK messages with proper enhanced-mode framing, MSA-3 text, and ERR segments. The default Mirth ACK is often rejected by Epic/Cerner because of missing MSA-3 or non-enhanced ACK type.

## What this builds

| ACK Type | When to use | What it returns |
|---|---|---|
| `AA` (Application Accept) | Success | `MSH … ACK^<event>^ACK …` + `MSA\|AA\|<orig-control-id>\|<text>` |
| `AE` (Application Error) | Transient problem (DB down, downstream timeout) | Above + `ERR` segment with diagnostic info |
| `AR` (Application Reject) | Permanent rejection (validation failed, patient not on roster) | Above + `ERR` segment with reject reason |

## Key fix vs Mirth defaults

- **Enhanced ACK type** — `ACK^A01^ACK` instead of just `ACK` (HL7 v2.4+ standard)
- **Sender/receiver swap** — MSH-3/4/5/6 fields properly inverted
- **MSA-3 populated** — human-readable status (Epic rejects empty MSA-3 in some contracts)
- **ERR segments** — generated for AE/AR with severity, code, diagnostic text

## Where to install

Use **Source Connector → Response Map** with a Code Template containing the `buildAck()` function. Then in your response transformer:

```javascript
var ack;
if (channelMap.get('validationFailed')) {
    ack = buildAckAE(connectorMessage.getRawData(), '101', 'Required field missing', 'PID-3 is empty');
} else {
    ack = buildAckAA(connectorMessage.getRawData(), 'Bundle persisted with 9 resources');
}
responseMap.put('customAck', ack);
```

Then on the Source Connector → Response = `${customAck}`.

## Tested output

Input MSH:
```
MSH|^~\&|EPIC|MGH|MIRTH|HUB|20260528120000||ADT^A01|MSG001|P|2.5.1
```

AA response:
```
MSH|^~\&|MIRTH|HUB|EPIC|MGH|20260528120000||ACK^A01^ACK|ACK20260528120000|P|2.5.1
MSA|AA|MSG001|Bundle persisted successfully
```

AE response with ERR:
```
MSH|^~\&|MIRTH|HUB|EPIC|MGH|20260528120000||ACK^A01^ACK|ACK20260528120000|P|2.5.1
MSA|AE|MSG001|Validation failed
ERR|||101^Required field missing|E|||PID-3 is empty
```

## Code

[code-template.js](code-template.js) — drop this into a Mirth Code Template named `ack-builder`.
