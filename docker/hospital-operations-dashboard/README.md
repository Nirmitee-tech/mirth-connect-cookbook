# Hospital Operations Dashboard for Mirth Connect

> Prometheus + Grafana observability that speaks **clinical workflow**, not channel mechanics. Plus a scenario simulator so you can demo it telling a real story.

Most Mirth dashboards are built for the integration engineer at 2am. This one is built for the CIO, hospital ops team, and compliance officer who need to know: *which patients are affected right now? Are lab results reaching ICU? Is revenue at risk?*

---

## What's in the box

| Component | Role |
|---|---|
| `exporter/` | Standalone Python Prometheus exporter. Polls Mirth REST API every scrape, classifies each channel into a clinical interface type (ADT, Results, Orders, Pharmacy, Claims, Scheduling, Documents, Immunization, Data Lake, Clinical Repo), emits both per-channel metrics and per-interface rollups. |
| `prometheus.yml` | Scrape config — 15s intervals to the exporter. |
| `grafana/dashboards/hospital-operations.json` | **The main dashboard.** Patient-impact tiles, critical interface status table, clinical message throughput by interface type, freshness signals tied to clinical-hour expectations. |
| `grafana/dashboards/mirth-overview.json` | Generic infrastructure view (for the integration engineer at 2am). Kept around because both audiences exist. |
| `scenarios/provision_channels.py` | One-shot provisioner that clones the demo ADT channel into 4 clinical-named channels (Results/Orders/Claims/Pharmacy) so the dashboard has interface variety to show. |
| `scenarios/run_scenario.py` | Six named demo scenarios that drive realistic traffic patterns. |

---

## Quick start

```bash
docker compose up -d

# Wait ~30s for Mirth to be ready, then:
pip install -r scenarios/requirements.txt
python3 scenarios/provision_channels.py        # creates Results/Orders/Claims/Pharmacy channels
python3 scenarios/run_scenario.py mixed-shift  # 5-minute realistic demo
```

Open the dashboard:

```
http://localhost:3001/d/hospital-ops/hospital-integration-operations
```

The dashboard refreshes every 5s. No login needed — anonymous Admin is enabled for demo convenience (turn it off for any non-local use).

---

## Why this dashboard exists

A generic Mirth-metrics dashboard tells a DevOps engineer "the plumbing is working." It tells a hospital CIO nothing they care about:

- **"How many patients are affected right now?"**
- **"Are lab results reaching ICU on time?"**
- **"Will we fail a Cures Act audit because of this?"**
- **"How much revenue is at risk from stuck claims?"**

So this dashboard reframes the same Mirth metrics through a clinical-operations lens. Each panel answers an operations or compliance question, not an infrastructure one.

### Panels and what they answer

| Panel | Operational question it answers |
|---|---|
| **Patient-Impact Backlog (ADT)** | Is bed management / registration operating blind? |
| **Lab/Rad Results Backlog** | Are clinicians waiting on results that already exist? |
| **Order Routing Backlog** | Are workups not reaching the lab / RIS / pharmacy? |
| **Revenue Cycle Backlog (Claims)** | How much revenue is sitting still? |
| **Critical Interface Status** (table, sorted by queue) | Which clinical workflow is most at risk *right now*? |
| **Last Msg (s ago)** column | Has any interface gone silent? (Yellow >5min, red >15min — calibrated to clinical-hour expectations.) |
| **Clinical Message Throughput by interface** | Where did the upstream system trouble actually originate? |
| **Interfaces Down** | How many clinical workflows are completely blind? |
| **Interfaces With Errors** | How many workflows are failing data quality checks? |

### Interface classification

The exporter classifies each Mirth channel by name pattern at scrape time. The mapping lives in `exporter/mirth_exporter.py` (`INTERFACE_RULES`):

| Pattern matches | Interface type | Clinical impact label |
|---|---|---|
| `ADT`, `admission`, `discharge`, `transfer`, `patient reg` | ADT | Bed mgmt, registration, census |
| `ORM`, `order entry`, `servicerequest` | Orders | Lab/Rad/Pharmacy orders flow |
| `ORU`, `result`, `diagnosticreport`, `lab` | Results | Lab/Rad results to chart |
| `RDS`, `RDE`, `pharmacy`, `medication` | Pharmacy | Medication safety, MAR |
| `837`, `835`, `270`, `271`, `278`, `claim`, `billing` | Claims | Revenue cycle, AR |
| `SIU`, `schedul`, `appointment` | Scheduling | OR/clinic scheduling |
| `MDM`, `document`, `note`, `transcrip` | Documents | Clinical documentation |
| `VXU`, `immun`, `vaccin` | Immunization | Vaccination registry |
| `kafka` | Data Lake | Analytics, ML feature store |
| `openehr`, `composition`, `CDR` | Clinical Repo | Longitudinal record (openEHR) |
| `fhir` | FHIR Pipeline | Downstream FHIR consumers |
| `router`, `smart` | Routing | Cross-system message routing |
| (none of the above) | Other | Uncategorized |

Edit `INTERFACE_RULES` to match your channel naming convention before rolling this out in production.

---

## Metrics emitted

```
# Per-channel (carry interface_type + clinical_impact labels)
mirth_channel_state{channel,channel_id,interface_type,clinical_impact,state}   gauge 0|1
mirth_channel_received_total{channel,channel_id,interface_type,clinical_impact} counter
mirth_channel_sent_total{...}                                                   counter
mirth_channel_filtered_total{...}                                               counter
mirth_channel_errored_total{...}                                                counter
mirth_channel_queued{...}                                                       gauge
mirth_channel_seconds_since_last_message{...}                                   gauge

# Per clinical interface (rollups for the operations dashboard)
mirth_interface_messages_received_total{interface_type}                         counter
mirth_interface_messages_errored_total{interface_type}                          counter
mirth_interface_queue_depth{interface_type}                                     gauge
mirth_interface_channels_started{interface_type}                                gauge
mirth_interface_channels_total{interface_type}                                  gauge

# Exporter health
mirth_exporter_up                                                               gauge
mirth_exporter_scrape_duration_seconds                                          gauge
```

---

## Scenarios

`scenarios/run_scenario.py list` to see them all. Each scenario lights up specific panels so the dashboard tells a story.

### `normal` — 60s baseline
Steady ADT every 1.5s plus light Results/Orders/Pharmacy/Claims. **Dashboard mostly green.** Use this as the "before" state for comparisons.

### `burst-results` — 500 ORU spike
A lab analyzer dumps a batch. **Lab/Rad Results Backlog tile climbs**, Results line spikes on the throughput chart, Results row moves to the top of the Critical Interface Status table (sorted by queue depth).

### `claims-eod` — 1000 DFT in 30 seconds
Realistic for hospital billing systems that batch transactions to the clearinghouse at end-of-day. **Revenue Cycle Backlog tile climbs**, Claims line spikes on throughput.

### `adt-outage` — ADT channel stops for 60s
Worst-case interface failure during clinical hours. **Interfaces Down tile flips red**, Critical Interface Status row turns red, `Last Msg (s ago)` for ADT climbs through yellow → red thresholds.

### `error-storm` — 100 malformed messages
Simulates a schema mismatch from an upstream EHR after a vendor upgrade. **Interfaces With Errors counts up**, Errors column on the status table lights up red. (Note: only channels with real source transformers will register errors; see "Source transformer note" below.)

### `mixed-shift` — 5-minute realistic shift
**This is the demo to show.** Embedded incidents through the shift:

| Time | Phase |
|:---:|---|
| 0:00 – 1:00 | Steady baseline |
| 1:00 – 1:30 | Morning lab batch (Results spike) |
| 1:30 – 2:30 | Quiet — system recovers |
| 2:30 – 2:45 | Schema mismatch from upstream EHR (error storm) |
| 2:45 – 3:30 | Steady |
| 3:30 – 4:30 | Noon orders rush (Orders spike) |
| 4:30 – 4:45 | ADT interface flap (stop/start) |
| 4:45 – 5:00 | End-of-day claims batch |

Open the dashboard and run this end-to-end while watching. Every panel changes for a reason a clinician would understand.

---

## Limitations & honest gaps

The dashboard is a meaningful step up from generic Mirth metrics, but it does **not yet measure**:

1. **True clinical SLAs** — order → result turnaround, door → page time, discharge → PCP delivery. These need message-level timestamp parsing (`MSH-7` vs delivery time per message) and per-message correlation. The exporter only sees aggregate counters.
2. **Patient counts behind a queue** — "5 patients have stuck ADT" is more useful than "5 messages queued." Needs PID parsing to count distinct patients, not just messages.
3. **Compliance metrics** — Cures Act Patient Access API uptime, TEFCA QHIN delivery rate, info-blocking response time. These need additional probes and SLA windows.
4. **Cost-of-outage in dollars** — wire revenue-per-claim and avg LOS impact-per-delayed-ADT to convert backlog into $/min impact.

These are good next-iteration items. The bottom panel of the dashboard explicitly calls them out so demo viewers know what's promised vs. aspirational.

### Source transformer note

The Results/Orders/Claims/Pharmacy channels provisioned by `provision_channels.py` are simple receivers — they don't validate HL7v2 structure. So `error-storm` mostly lights up the ADT channel (which has a real FHIR transformer that fails on malformed input).

To make the error storm fan out across all interfaces in production, add a source transformer that validates required segments and routes failures to the error queue:

```javascript
// Source transformer — minimal HL7v2 structural validation
try {
    var msg = msg;  // HL7v2 message object
    if (!msg['MSH']['MSH.10']['MSH.10.1'].toString()) {
        channel.getResponseMap().put('validation', ResponseFactory.getErrorResponse('Missing MSH-10'));
        return;
    }
    // ... segment-specific checks ...
} catch (e) {
    channel.getResponseMap().put('validation', ResponseFactory.getErrorResponse(e.toString()));
}
```

---

## Production hardening

Before rolling this to production:

1. **Lock down anonymous Grafana access.** Set `GF_AUTH_ANONYMOUS_ENABLED: "false"` and provision real users (or wire SAML/OIDC).
2. **TLS everywhere.** The exporter talks HTTPS to Mirth but skips cert verification (`verify=False`). Mount the Mirth CA and remove the bypass.
3. **Secret management.** Replace `MIRTH_USER`/`MIRTH_PASS` env vars with secret references (Docker secrets, Vault, AWS Secrets Manager).
4. **Tune classification rules.** `INTERFACE_RULES` ships with the most common patterns. Add organization-specific channel naming.
5. **Alerting.** The current setup is observability-only. Add Alertmanager rules for: `mirth_interface_channels_started < mirth_interface_channels_total`, `mirth_interface_queue_depth{interface_type="ADT"} > 25`, `mirth_channel_seconds_since_last_message{interface_type=~"ADT|Results"} > 900`.
6. **Retention.** Default Prometheus retention is 15 days. For HIPAA audit context, snapshot daily to long-term storage (Thanos/Mimir/S3).
7. **PHI safety.** The exporter only reads channel statistics — no message content. But if you customize it to inspect messages, never emit PHI in metric labels (cardinality and HIPAA both bite).

---

## Architecture

```
       ┌──────────────┐    polls REST API    ┌──────────────────┐
       │   Mirth      │ ──────────────────── │  Python exporter │
       │   Connect    │    /api/channels/    │      :9100       │
       │   :8443      │       statuses       │  + classifier    │
       └──────────────┘                      └────────┬─────────┘
              ▲                                       │ /metrics
              │ MLLP test traffic                     │
       ┌──────┴──────┐                       ┌────────▼─────────┐
       │  scenarios/ │                       │   Prometheus     │
       │  run_*.py   │                       │      :9090       │
       └─────────────┘                       └────────┬─────────┘
                                                      │ PromQL
                                             ┌────────▼─────────┐
                                             │     Grafana      │
                                             │     :3001        │
                                             │  Hospital Ops    │
                                             │     Dashboard    │
                                             └──────────────────┘
```

The exporter is intentionally external — not a Mirth channel. This sidesteps the Java 17 classloader issues that bite the in-channel approach, makes it easy to extend (just edit Python), and means the metrics endpoint stays up even when Mirth is down (so you can see "Mirth Connect itself is down" as a metric).

---

## File map

```
docker/hospital-operations-dashboard/
├── README.md                                this file
├── docker-compose.yml                       full stack (Mirth + DB + exporter + Prom + Grafana)
├── prometheus.yml                           15s scrape against the exporter
├── exporter/
│   ├── Dockerfile                           python:3.12-slim
│   └── mirth_exporter.py                    scraper + interface classifier
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/prometheus.yml       wires Prometheus as default datasource
│   │   └── dashboards/dashboards.yml        auto-loads JSON from /var/lib/grafana/dashboards
│   └── dashboards/
│       ├── hospital-operations.json         the headline dashboard
│       └── mirth-overview.json              generic infra view
└── scenarios/
    ├── requirements.txt                     requests, urllib3
    ├── provision_channels.py                creates Results/Orders/Claims/Pharmacy channels
    └── run_scenario.py                      six demo scenarios
```
