# Recipe #41 — Epic Bridges MLLP Adapter

**Description.** Bidirectional Epic Bridges integration for Mirth Connect.
Receives ADT traffic from Epic (`adt-channel.xml`), suppresses A28/A31
duplicates Epic emits for every chart update, normalises Epic-specific
PV1-2 patient class codes, parses custom Z-segments (ZPV / ZIN), and
emits a clean FHIR Bundle. Outbound (`dft-channel.xml`) reads a charge
manifest from `channelMap.charges` and ships DFT^P03 charge messages
back to Epic over MLLP with queue-on-failure semantics.

**Use case.** Stand up a vendor-neutral interoperability hub in front of
Epic without modifying the Epic side except for standard Bridges
configuration. Lets you fan ADT out to a data warehouse, FHIR proxy, and
analytics platform simultaneously while pushing pharmacy/charges back.

**Requirements.**
- Mirth Connect 4.5.2+
- Epic Bridges configured to send ADT to the Mirth host (see "Epic-side
  configuration" below)
- Network: TCP 6701 inbound to Mirth, outbound to whatever port Epic
  Bridges exposes (commonly 7102)
- Configuration Map keys (Admin -> Settings -> Configuration Map):
  - `epic.sending.app`        e.g. `MIRTH`
  - `epic.sending.facility`   e.g. `HUB`
  - `epic.receiving.app`      e.g. `EPIC`
  - `epic.receiving.facility` e.g. `BRIDGES`
  - `epic.bridges.host`       e.g. `epic-bridges.hospital.local`
  - `epic.bridges.dft.port`   e.g. `7102`

**Tested on.** Mirth Connect 4.5.2 against an Epic 2024 Bridges feed
(simulated via the cookbook's `send-test-hl7v2.py`)  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
epic-bridges-mllp/
├── README.md
├── adt-inbound-transformer.js     # ADT -> FHIR Bundle + Epic quirks
├── dft-outbound-transformer.js    # build DFT^P03 charges
├── build-channels.py              # bake the JS into channel XMLs
├── adt-channel.xml                # generated; import to Mirth
└── dft-channel.xml                # generated; import to Mirth
```

## Where to install

1. Open the Configuration Map (Admin -> Settings) and add the six
   `epic.*` keys listed above.
2. Mirth Administrator -> Channels -> Import Channel ->
   `channels/epic-bridges-mllp/adt-channel.xml`.
3. Repeat for `dft-channel.xml`.
4. Deploy both. The ADT channel listens on TCP 6701; the DFT channel
   listens on the VM source and dispatches MLLP to
   `${epic.bridges.host}:${epic.bridges.dft.port}`.

After editing either transformer:

```bash
cd channels/epic-bridges-mllp
python3 build-channels.py
# re-import the regenerated *-channel.xml
```

## How to test

### ADT inbound

```bash
# Send an A01 admit then an A08 update via the cookbook's MLLP sender.
python3 scripts/testing/send-test-hl7v2.py --port 6701 --message-type ADT_A01
python3 scripts/testing/send-test-hl7v2.py --port 6701 --message-type ADT_A08

# Verify Epic dedup: A28 twice within 10 minutes -> second is suppressed.
# (send-test-hl7v2.py doesn't ship A28; craft one and pipe via netcat:
#   printf '\x0bMSH|...|ADT^A28|...\x1c\x0d' | nc -q1 localhost 6701 )
```

Inspect Dashboard -> Message Browser -> Channel Map:

- `triggerEvent`         = `A01` / `A08` / `A28`
- `epicVisitId`          = the CSN from PV1-19
- `epicPatientClass`     = raw PV1-2 (`I`, `O`, `E`, ...)
- `duplicateSuppressed`  = `true` on the second A28/A31 within 10 min
- `fhirBundle`           = the JSON Bundle (Patient + Encounter)

### DFT outbound

```javascript
// From another channel:
channelMap.put('charges', JSON.stringify([{
  patientMrn: 'PAT-12345',
  csn: 'V-DEMO-1',
  lastName: 'Smith', firstName: 'John',
  dob: '19850315', gender: 'M',
  departmentCode: 'ICU',
  lines: [
    { cptCode: '99291', description: 'Critical Care 30-74 min',
      amount: '295.00', qty: '1', serviceDate: '20260528' }
  ]
}]));
router.routeMessageByChannelId('22222222-2222-2222-2222-222222222222', '');
```

Watch the DFT channel's destination logs — you should see one
`DFT^P03^DFT_P03` MLLP frame containing MSH | EVN | PID | PV1 | FT1.

## Epic-side configuration (high-level, for the Epic analyst)

Bridges is configured per-interface in Epic's Interface Management
(`I MIR`). Talk to your Epic interface analyst — they'll know the
specifics for your release. The relevant settings:

| Bridges Field | Value |
|---|---|
| Outbound interface type | `Network` (TCP/IP MLLP) |
| Outbound transport | `MLLP` |
| Mirth host | `mirth.hospital.local` (DNS) |
| Mirth port | `6701` |
| Encoding | `UTF-8` (or `ASCII` for legacy) |
| Field separator | `|` |
| Encoding chars | `^~\&` |
| Ack mode | `Original Mode` (AA/AE/AR) |
| Filters | Subscribe to A01, A02, A03, A04, A08, A11, A12, A13, A28, A31, A40 |
| Custom segments | enable ZPV, ZIN (Epic FDI build) |

For the **DFT** inbound on the Epic side:

| Bridges Field | Value |
|---|---|
| Inbound interface type | `Network` (TCP/IP MLLP) |
| Inbound port | the value you set as `epic.bridges.dft.port` |
| Trigger events | `P03` (Detailed Financial Transaction) |
| Expected segments | MSH, EVN, PID, PV1, FT1 |

## What the transformers do

### ADT inbound (`adt-inbound-transformer.js`)

- **Dedup.** A28 (add person) and A31 (update person) are stored in
  `globalChannelMap` keyed by `(trigger, PID-3)`. If the same key was
  seen <10 min ago, sets `duplicateSuppressed='true'` and exits early —
  downstream destinations should filter on that flag.
- **Patient class mapping.** Epic-specific PV1-2 codes (`I`, `O`, `E`,
  `P`, `R`, `B`) -> FHIR v3-ActCode (`IMP`, `AMB`, `EMER`, `PRENC`,
  `AMB`, `OBSENC`).
- **Z-segments.** `ZPV` -> Encounter.extension (discharge disposition,
  cost center). `ZIN` -> reserved for Coverage.extension when you wire
  insurance through.
- **HL7 escape unescape.** Handles Epic's `\F\` `\S\` `\R\` `\T\` `\E\`
  sequences in free-text fields.

### DFT outbound (`dft-outbound-transformer.js`)

- **Builds DFT^P03.** One MSH + EVN + PID + PV1 + N×FT1 per patient.
- **Multiple patients.** `channelMap.charges` is an array — each
  element produces one DFT frame; all frames concatenated with `\r` and
  shipped in one TCP burst.
- **Escaping.** Calls `escapeHL7()` on every free-text field to defang
  `| ^ ~ & \\`.

## Customize

- **Dedup window.** Edit `DEDUP_WINDOW_MS` in the inbound transformer.
- **More Z-segments.** Add fields under the `var zpvExtras = {};` block.
- **More PV1-2 codes.** Extend `EPIC_CLASS_MAP`.
- **Trigger events.** The inbound channel auto-accepts any ADT —
  filtering is done on the FHIR side or via a Mirth filter step.
- **Multi-tenant routing.** Switch the DFT destination's
  `<remoteAddress>` to a Velocity expression keyed off
  `channelMap.facility` to fan out to multiple Epic instances.
