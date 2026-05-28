# Recipe #1 — HL7v2 Batch Splitter (BHS/BTS or Newline-Delimited)

Splits an HL7v2 batch (BHS … BTS framing) or a newline-delimited multi-message file into individual messages, preserving the original sequence and parent batch identifiers.

## When to use

- Lab vendors (Quest, LabCorp, regional labs) ship multi-result batch files (BHS/BTS or FHS/FTS framing).
- Pharmacy or imaging systems sometimes batch end-of-day result drops.
- Legacy file-drop interfaces that concatenate multiple HL7v2 messages in one file.

## How it works

The recipe uses Mirth's built-in HL7v2 batch processing on the source connector. Set:

- **Source connector** = File Reader or TCP Listener
- **Data type** = HL7 v2.x
- **Batch processing** = ENABLED
- **Split by** = "MSH Segment"

This is the *Mirth-native* way to split. The transformer recipe below is for the case where you want **custom batch logic** (e.g., extract BHS metadata to channel map, validate batch counts, route per batch).

## Files

- [batch-splitter-script.js](batch-splitter-script.js) — drop into Source connector → Batch Settings → "JavaScript" splitType
- [README.md](README.md) — this file

## Test (Mirth 4.5.2)

```bash
# Send a multi-message batch via MLLP
python3 ../../scripts/testing/send-hl7-batch.py --port 6661 --file ../../sample-data/hl7v2/oru-batch-3-results.hl7
# Expected: 3 ACKs, channel statistics show Received: 3
```
