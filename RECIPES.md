# Mirth Connect Cookbook — Recipe Index

50 production-grade recipes covering Mirth Connect A-to-Z, organized by category. Each recipe is tested against a live Mirth Connect 4.5.2 deployment before being committed.

Status legend: ✅ tested & committed | 🚧 in progress | 📋 planned

---

## Tier 1 — Highest Demand (build first)

| # | Recipe | Status | Category |
|---|---|:---:|---|
| 1 | [hl7v2-batch-splitter-bhs-bts](transformers/hl7v2-batch-splitter-bhs-bts/) | 🚧 | Channel Patterns |
| 2 | [hl7v2-adt-deduplicator](transformers/hl7v2-adt-deduplicator/) | 🚧 | Channel Patterns |
| 3 | [hl7v2-ack-customizer](transformers/hl7v2-ack-customizer/) | 🚧 | Source Connectors |
| 4 | [mllp-sender-with-retry](channels/mllp-sender-with-retry/) | 🚧 | Destination Connectors |
| 5 | [hl7v2-oru-to-fhir-diagnosticreport](transformers/oru-to-fhir-diagnosticreport/) | 🚧 | Data Transformations |
| 6 | [hl7v2-adt-to-fhir-patient-encounter](transformers/adt-to-fhir-patient-encounter/) | 🚧 | Data Transformations |
| 7 | [database-writer-upsert-postgres](channels/database-writer-upsert-postgres/) | 🚧 | Destination Connectors |
| 8 | [prometheus-metrics-exporter](channels/prometheus-metrics-exporter/) | 🚧 | Operations |
| 9 | [http-sender-oauth2-jwt](code-templates/http-sender-oauth2-jwt/) | 🚧 | Security |
| 10 | [database-pruning-vacuum](scripts/operations/database-pruning-vacuum/) | 🚧 | Operations |

## Tier 2 — Core Coverage (11-25)

| # | Recipe | Status | Category |
|---|---|:---:|---|
| 11 | hl7v2-orm-to-fhir-servicerequest | 📋 | Transformations |
| 12 | hl7v2-siu-to-fhir-appointment | 📋 | Transformations |
| 13 | hl7v2-mdm-to-fhir-documentreference | 📋 | Transformations |
| 14 | hl7v2-vxu-to-fhir-immunization | 📋 | Transformations |
| 15 | fhir-r4-to-hl7v2-adt-reverse | 📋 | Transformations |
| 16 | x12-270-271-eligibility-transformer | 📋 | Transformations |
| 17 | x12-837-claim-transformer | 📋 | Transformations |
| 18 | x12-835-remittance-parser | 📋 | Transformations |
| 19 | ncpdp-script-to-fhir-medicationrequest | 📋 | Transformations |
| 20 | dicom-c-store-listener | 📋 | Source Connectors |
| 21 | file-reader-sftp-with-rotation | 📋 | Source Connectors |
| 22 | http-listener-fhir-facade | 📋 | Source Connectors |
| 23 | http-listener-soap-wsdl | 📋 | Source Connectors |
| 24 | database-reader-cdc-polling | 📋 | Source Connectors |
| 25 | javascript-reader-kafka-consumer | 📋 | Source Connectors |

## Tier 3 — Reliability, Security, Ops (26-40)

| # | Recipe | Status | Category |
|---|---|:---:|---|
| 26 | circuit-breaker-pattern | 📋 | Channel Patterns |
| 27 | dead-letter-queue-channel | 📋 | Channel Patterns |
| 28 | message-replay-rest-endpoint | 📋 | Operations |
| 29 | rate-limiter-token-bucket | 📋 | Channel Patterns |
| 30 | mllps-tls-mutual-auth | 📋 | Security |
| 31 | phi-masking-code-template | 📋 | Security |
| 32 | hipaa-audit-trail-channel | 📋 | Security |
| 33 | vault-integration-secrets | 📋 | Security |
| 34 | database-pruning-vacuum | 📋 | Operations |
| 35 | backup-restore-automation | 📋 | Operations |
| 36 | channel-status-watchdog | 📋 | Operations |
| 37 | loki-log-aggregation | 📋 | Operations |
| 38 | performance-benchmark-suite | 📋 | Testing |
| 39 | channel-unit-test-framework | 📋 | Testing |
| 40 | us-core-validation-channel | 📋 | Testing |

## Tier 4 — Integrations & DevOps (41-50)

| # | Recipe | Status | Category |
|---|---|:---:|---|
| 41 | epic-bridges-mllp-adapter | 📋 | Integrations |
| 42 | cerner-millennium-fhir-r4-pull | 📋 | Integrations |
| 43 | redox-app-adapter | 📋 | Integrations |
| 44 | health-gorilla-bulk-data | 📋 | Integrations |
| 45 | openemr-hl7v2-bidirectional | 📋 | Integrations |
| 46 | active-active-cluster-postgres | 📋 | HA & DR |
| 47 | kubernetes-helm-chart | 📋 | DevOps |
| 48 | terraform-aws-mirth-module | 📋 | DevOps |
| 49 | github-actions-channel-ci | 📋 | DevOps |
| 50 | multi-environment-promotion | 📋 | DevOps |

---

## Test Strategy

Every recipe is verified against the local docker-compose stack:
- **Code templates / transformers** — syntax validated + smoke-tested via a deployed channel
- **Channels** — imported into the running Mirth instance, deployed to STARTED state, exercised with sample messages
- **Scripts** — executed end-to-end against the live Mirth REST API
- **Docker / K8s / Terraform** — `validate`/`lint` passes + sample bring-up works

Only recipes that pass are merged.
