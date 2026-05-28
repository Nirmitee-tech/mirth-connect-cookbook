# Recipe #2 — HL7v2 ADT Deduplicator

Drop duplicate ADT messages within a configurable TTL window.

## Why this exists

Epic and Cerner ADT feeds frequently **double-send** during HA failover, interface restart, or message re-queue events. Without dedup logic, downstream FHIR servers see the same admission/discharge twice, leading to:

- Duplicate Encounter resources in your FHIR store
- Double notifications to clinicians
- Audit log noise
- Billing reconciliation errors

## How it works

Hash 4 fields from each ADT message:

| Field | Source | Purpose |
|---|---|---|
| MSH-10 | Message Control ID | Should be unique per message |
| PID-3 | Patient MRN | Anchor to the patient |
| EVN-2 | Event Timestamp | Should be identical for replays |
| MSH-9.2 | Trigger Event (e.g., A01) | Distinguish admit vs discharge |

→ MD5 → cache in `globalChannelMap` with TTL (24h default) → on hit, drop the message via filter return `false`.

## Where to install

**Source Connector → Filter → Add Step → JavaScript** — paste `code-template.js` content.

## Configuration

Edit constants at top of the script:

```javascript
var DEDUP_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
var MAX_CACHE_SIZE = 100000;              // Memory cap
```

## Scaling beyond 100K messages/day

`globalChannelMap` is in-memory. For larger volumes, swap the `ConcurrentHashMap` for a Redis client. See [code-templates/circuit-breaker](../../code-templates/circuit-breaker/) for the Redis pattern.

## Test (Mirth 4.5.2)

```bash
# Send same ADT twice — only first should pass filter
python3 ../../scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01 --count 2

# Mirth dashboard should show: Received: 2, Filtered: 1, Sent: 1
```

## What the channel logs look like

```
INFO  transformer: ADT DEDUP: Dropping duplicate MRN=PAT-12345 MSG-ID=MSG-001 triggerEvent=A01 originalAgeMs=1234
```
