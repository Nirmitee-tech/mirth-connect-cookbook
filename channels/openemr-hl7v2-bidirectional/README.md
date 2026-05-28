# Recipe #45 — OpenEMR HL7v2 Bidirectional Adapter

**Description.** Bidirectional HL7v2 bridge between OpenEMR and any
downstream EMR/HIE/LIS via Mirth.

- **ADT inbound** (`adt-inbound.xml`) — listens on MLLP 6611, accepts
  ADT^A0x from the OpenEMR HL7 module, promotes OpenEMR's PID-2
  external_id to a proper MRN, normalises the non-standard PID-13
  phone format, and patches missing MSH-9.2 trigger event codes.
- **ORU outbound** (`oru-outbound.xml`) — reads a JSON lab result
  payload from `channelMap.labResultJson`, builds an ORU^R01 that
  OpenEMR's HL7 receiver actually accepts (PID-2 *and* PID-3 carry the
  MRN; OBX-5 repeats use `~`).

**Use case.** Wire OpenEMR into a heterogeneous interoperability
landscape — e.g. send ADT from OpenEMR to Epic via Mirth, return lab
results from a reference LIS back to OpenEMR.

**Requirements.**
- Mirth Connect 4.5.2+
- OpenEMR 7.0.x with the HL7 module enabled (Administration ->
  Globals -> Connectors -> HL7)
- Configuration Map keys:
  - `openemr.host`            e.g. `openemr.clinic.local`
  - `openemr.port`            e.g. `6661` (OpenEMR HL7 listener port)
  - `openemr.sending.app`     default `MIRTH`
  - `openemr.sending.facility` default `HUB`
  - `openemr.receiving.app`   default `OPENEMR`
  - `openemr.receiving.facility` default `CLINIC`

**Tested on.** Mirth Connect 4.5.2 with OpenEMR 7.0.2 HL7 module  
**Author.** Nirmitee.io | **License.** MIT

---

## Files

```
openemr-hl7v2-bidirectional/
├── README.md
├── adt-inbound-transformer.js
├── oru-outbound-transformer.js
├── build-channels.py
├── adt-inbound.xml        # generated
└── oru-outbound.xml       # generated
```

## Where to install

1. **Mirth side.**
   - Configuration Map -> add the `openemr.*` keys above.
   - Channels -> Import -> `adt-inbound.xml`.
   - Channels -> Import -> `oru-outbound.xml`.
   - Deploy both. ADT listens on TCP 6611; ORU dispatches MLLP to
     `${openemr.host}:${openemr.port}`.

2. **OpenEMR side.**
   - `Administration -> Globals -> Connectors -> HL7`:
     - Enable the listener (typically port 6661)
     - Set "Receiving App" = `OPENEMR`, "Receiving Facility" = `CLINIC`
       (or whatever you set in the Configuration Map)
   - `Administration -> Modules -> HL7` (if installed): subscribe the
     module to emit ADT^A0x on patient create/update.
   - For lab results to land on the correct patient, ensure the
     OpenEMR patient `external_id` (the value visible in PID-2) is
     populated. The transformer writes the MRN to **both** PID-2 and
     PID-3 to survive both lookup paths.

After editing either transformer:

```bash
cd channels/openemr-hl7v2-bidirectional
python3 build-channels.py
# re-import the regenerated *.xml
```

## How to test

### ADT inbound

```bash
# Send an A01 with OpenEMR-style PID-2 as the MRN (PID-3 empty):
printf '\x0bMSH|^~\\&|OPENEMR|CLINIC|MIRTH|HUB|20260528120000||ADT|MSG-1|P|2.5.1\rEVN|A04|20260528120000\rPID|1|PAT-9001||||Doe^Jane||19920720|F|||456 Oak Ave^^Chicago^IL^60601||312-555-9876\rPV1|1|O|CLINIC\r\x1c\x0d' | nc -q1 localhost 6611
```

Note: MSH-9 contains only `ADT` (no `^A04`) and PID-2 carries the MRN.
Inspect `channelMap`:

- `mrn`             = `PAT-9001`
- `mrnSource`       = `PID-2`  (because PID-3 was empty)
- `phone`           = `^PRN^PH^^^312^5559876`  (normalised from `312-555-9876`)
- `triggerEvent`    = `A04`  (rebuilt from EVN-1 when MSH-9.2 was empty)
- `messageStructure` = `ADT_A04`

### ORU outbound

From any upstream channel:

```javascript
channelMap.put('labResultJson', JSON.stringify({
  patient: { mrn: 'PAT-9001', lastName: 'Doe', firstName: 'Jane',
             dob: '19920720', gender: 'F' },
  order:   { orderId: 'ORD-3001', code: '6690-2', name: 'WBC',
             codingSystem: 'LN' },
  results: [
    { loinc: '6690-2', name: 'WBC',         value: '7.5',  units: '10*3/uL',
      refRange: '4.5-11.0', abnormalFlag: 'N' },
    { loinc: '718-7',  name: 'Hemoglobin',  value: '14.2', units: 'g/dL',
      refRange: '13.5-17.5', abnormalFlag: 'N' }
  ],
  observationDate: '20260528120000'
}));
router.routeMessageByChannelId('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '');
```

The destination logs should show a single MLLP frame:

```
MSH|^~\&|MIRTH|HUB|OPENEMR|CLINIC|20260528120000||ORU^R01^ORU_R01|ORU...|P|2.5.1
PID|1|PAT-9001|PAT-9001^^^HUB^MR||Doe^Jane||19920720|F
OBR|1|ORD-3001||6690-2^WBC^LN|||20260528120000|...|F
OBX|1|NM|6690-2^WBC^LN||7.5|10*3/uL|4.5-11.0|N|||F
OBX|2|NM|718-7^Hemoglobin^LN||14.2|g/dL|13.5-17.5|N|||F
```

OpenEMR's HL7 receiver should match on PID-3 first (then fall back to
PID-2), find Jane Doe, and post both observations against her chart.

## OpenEMR HL7 module configuration snippets

```php
// Site/<your-site>/config.php or via Globals UI

$GLOBALS['hl7_enable_listener']            = true;
$GLOBALS['hl7_listener_host']              = '0.0.0.0';
$GLOBALS['hl7_listener_port']              = 6661;
$GLOBALS['hl7_listener_application']       = 'OPENEMR';
$GLOBALS['hl7_listener_facility']          = 'CLINIC';
$GLOBALS['hl7_ack_send']                   = true;
$GLOBALS['hl7_ack_type']                   = 'AA';  // accept everything
$GLOBALS['hl7_match_field']                = 'pubpid'; // PID-2 external_id
// OR set hl7_match_field = 'pid' to match on PID-3 only — most
// installs leave it on 'pubpid' which is why we write MRN to PID-2.
```

ADT publish (OpenEMR module side):

```php
$GLOBALS['hl7_publish_adt']                = true;
$GLOBALS['hl7_publish_adt_remote_host']    = '<mirth-host>';
$GLOBALS['hl7_publish_adt_remote_port']    = 6611;
$GLOBALS['hl7_publish_adt_events']         = 'A01,A04,A08,A03';
```

## Customize

- **MRN namespace.** Change `MSH-4` or PID-3's component-4 (assigning
  authority) by tweaking the `sendingFacility` Configuration Map key.
- **OBX repeats.** Pass `value: ['12.0', '13.5', '14.2']` to emit `~`-
  separated values in OBX-5. OpenEMR honours those out of the box; many
  other EMRs do not.
- **Add NTE.** Append note segments to `labResultJson.results[].notes`
  and extend the ORU transformer's segment loop.
- **PID-2 vs PID-3 strategy.** If your OpenEMR instance has been
  reconfigured to match on PID-3 only (`hl7_match_field = 'pid'`),
  drop the PID-2 write in `oru-outbound-transformer.js`. Most
  out-of-the-box installs still use `pubpid`/PID-2.
- **A28/A31 fan-in.** If you also receive Epic-style A28/A31 traffic
  on the same listener and want OpenEMR-matching behaviour, chain this
  recipe behind the Epic dedup transformer from recipe #41.

## Known OpenEMR quirks captured by this recipe

| Quirk | What we do |
|---|---|
| OpenEMR uses PID-2 as canonical MRN | promote PID-2 -> MRN if PID-3 empty; outbound writes both |
| OpenEMR PID-13 phone in `617-555-1234` form | normalise to `^PRN^PH^^^617^5551234` |
| OpenEMR drops MSH-9.2 sometimes | rebuild from EVN-1 |
| OpenEMR rejects OBX-5 with `,` or `\n` for repeats | force `~` separator |
| OpenEMR validates MSH-3/MSH-4 against interface registration | sourced from Configuration Map |
