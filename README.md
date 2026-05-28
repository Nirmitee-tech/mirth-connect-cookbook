# Mirth Connect Cookbook

> Production-grade Mirth Connect recipes, transformers, channels, and deployment scripts — tested in real Mirth 4.5.2 deployments.

Maintained by [Nirmitee.io](https://nirmitee.io/mirth-connect-integration/) — healthcare integration engineers building Mirth Connect at scale.

---

## What's in this cookbook

Every recipe in this repository has been **executed end-to-end** in a working Mirth Connect 4.5.2 environment with PostgreSQL backend, Kafka, and an external FHIR terminology server. The error messages, classloader fixes, and configuration patterns reflect what actually works on Java 17 — not what the docs claim.

### Transformers (JavaScript for Mirth source/destination transformers)

| Recipe | What it does |
|---|---|
| [adt-to-fhir-bundle](transformers/adt-to-fhir-bundle/) | HL7v2 ADT^A01 → FHIR R4 Transaction Bundle with Patient, Encounter, Practitioner, Organization, Condition, Coverage, Flag resources. Includes 8 mapping tables and a business rules engine. |
| [icd10-to-snomed-crosswalk](transformers/icd10-to-snomed-crosswalk/) | Local ICD-10 → SNOMED CT crosswalk for dual coding on FHIR Condition resources. Covers 50 most common ICD-10 codes. |
| [tx-server-validation](transformers/tx-server-validation/) | Live validation against [tx.fhir.org](https://tx.fhir.org) using Apache HttpClient — the working pattern for HTTP calls from Mirth transformers on Java 17. |
| [hl7v2-to-openehr-flat](transformers/hl7v2-to-openehr-flat/) | HL7v2 ADT → openEHR FLAT Composition (42 fields). First-ever publicly documented integration with EHRbase CDR. |
| [oru-to-fhir-diagnosticreport](transformers/oru-to-fhir-diagnosticreport/) | HL7v2 ORU^R01 → FHIR DiagnosticReport + Observation Bundle. Lab results with LOINC mapping. |
| [siu-to-fhir-appointment](transformers/siu-to-fhir-appointment/) | HL7v2 SIU^S12 → FHIR Appointment resource. |
| [smart-adt-router](transformers/smart-adt-router/) | Content-based routing logic: route ADT messages by ward, age, admit type to different downstream systems. |

### Channels (importable Mirth XML)

| Recipe | What it does |
|---|---|
| [hl7v2-to-fhir-bundle](channels/hl7v2-to-fhir-bundle/) | Full channel: TCP Listener (MLLP) → transformer → Channel Writer. Drop-in importable XML. |
| [kafka-producer](channels/kafka-producer/) | Mirth produces FHIR Bundles to Kafka topic. Solves the classloader conflict for `KafkaProducer` from Rhino. |
| [smart-router](channels/smart-router/) | ADT router with priority-based destination selection. |
| [terminology-validator](channels/terminology-validator/) | HTTP Sender destination to tx.fhir.org with response parser. |
| [openehr-composition](channels/openehr-composition/) | HL7v2 → openEHR FLAT POST to EHRbase. |

### Code Templates (reusable libraries)

| Recipe | What it does |
|---|---|
| [apache-http-client](code-templates/apache-http-client/) | Wrapper for `Packages.org.apache.http` — the working HTTP client for Mirth on Java 17. |
| [kafka-producer-helper](code-templates/kafka-producer-helper/) | Reusable `KafkaProducer` factory with proper classloader handling. |
| [fhir-validator](code-templates/fhir-validator/) | Validate FHIR resources against US Core 6.1.0 profiles before sending downstream. |
| [mapping-tables](code-templates/mapping-tables/) | Facility, ward → specialty, payer, marital status, gender, patient class, admit type lookup tables. |
| [audit-logger](code-templates/audit-logger/) | HIPAA-compliant audit logging for every channel access. |
| [error-handler](code-templates/error-handler/) | Standard error handler with dead-letter routing, retry strategy, alert integration. |

### Scripts

| Recipe | What it does |
|---|---|
| [scripts/deployment/deploy-channel.sh](scripts/deployment/deploy-channel.sh) | Idempotent deployment via REST API. Handles auth, channel enable, deploy. |
| [scripts/deployment/export-channels.sh](scripts/deployment/export-channels.sh) | Export all channels for version control. |
| [scripts/deployment/undeploy-channel.sh](scripts/deployment/undeploy-channel.sh) | Safe undeploy with traffic drain. |
| [scripts/testing/send-test-hl7v2.py](scripts/testing/send-test-hl7v2.py) | Send sample ADT, ORU, SIU, MDM messages via MLLP. |
| [scripts/testing/kafka-bridge.py](scripts/testing/kafka-bridge.py) | Workaround for Mirth Kafka consumer classloader issue: Python bridge that consumes from Kafka and POSTs to Mirth HTTP Listener. |
| [scripts/migration/4-5-to-4-6-checklist.sh](scripts/migration/4-5-to-4-6-checklist.sh) | Pre-flight checklist for Mirth 4.5.2 → 4.6 commercial migration. |

### Docker

- [docker/docker-compose.yml](docker/docker-compose.yml) — full dev environment: Mirth 4.5.2 + PostgreSQL 16 + Kafka (KRaft mode) + tx.fhir.org reachable via Internet
- [docker/custom-lib/](docker/custom-lib/) — JARs that need to be in Mirth's classpath for Apache HttpClient + Kafka producer to work

### Sample Data

- [sample-data/hl7v2/](sample-data/hl7v2/) — Sample HL7v2 messages (ADT^A01/A03/A04/A08, ORM^O01, ORU^R01, SIU^S12, MDM^T02)
- [sample-data/fhir/](sample-data/fhir/) — Expected FHIR Bundle outputs for each input

---

## Quick start

```bash
git clone https://github.com/Nirmitee-tech/mirth-connect-cookbook.git
cd mirth-connect-cookbook
cd docker && docker compose up -d
# Wait for Mirth to be ready (~45 seconds)
# Login at https://localhost:8443 with admin / admin
```

Import any channel XML into your Mirth Administrator and send a test message:

```bash
python3 scripts/testing/send-test-hl7v2.py --port 6661 --message-type ADT_A01
```

---

## Why this exists

After running Mirth Connect 4.5.2 in production and hitting every classloader conflict, JAR dependency mismatch, and undocumented API quirk, we open-sourced the recipes that actually work. Each transformer, channel, and script in this repo solves a problem we've personally hit in a production deployment.

**The classloader fix for Java 17 HTTP calls** (in [code-templates/apache-http-client/](code-templates/apache-http-client/)) alone has saved us hundreds of debugging hours. The Mirth community forums have asked about this exact issue for years without a published answer.

---

## Need integration help?

This cookbook is open source under the MIT License. If you need:

- A Mirth Connect channel built or audited
- 4.5.2 → 4.6 / BridgeLink / OIE migration
- 24x7 managed services for production Mirth
- Epic, Cerner, lab system integration

Reach out: [nirmitee.io/get-in-touch](https://nirmitee.io/get-in-touch) or read the [Mirth Connect Integration services page](https://nirmitee.io/mirth-connect-integration/).

---

## Contributing

Pull requests welcome. Each recipe must:
1. Include a working `transformer.js` or `channel.xml`
2. Include a `README.md` documenting input, output, and known limitations
3. Be tested against Mirth Connect 4.5.2 or later
4. Use only Mirth's bundled libraries OR document the JAR dependencies needed in `custom-lib/`

---

## License

MIT. Use it, fork it, ship it.

---

## Related Reading

- [Mirth Connect License Change 2026: What Changed & Your Migration Options](https://nirmitee.io/blog/mirth-connect-commercial-transition-migrationstrategies-for-open-source-users/)
- [Mirth Connect Alternatives 2026: Honest Comparison of 8 Engines](https://nirmitee.io/blog/mirth-connect-alternatives-2026-after-licensing-change/)
- [BridgeLink: The Open-Source Mirth Connect Fork](https://nirmitee.io/blog/bridgelink-open-source-mirth-connect-fork-migration-guide/)
- [Top 10 Mirth Connect Integration Failures](https://nirmitee.io/blog/top-10-mirth-connect-integration-failures/)
- [What Reliable Mirth Connect Monitoring Looks Like in Production](https://nirmitee.io/blog/what-reliable-mirth-connect-monitoring-looks-like-in-production/)
