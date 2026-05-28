# Mirth Connect Interface Catalog Generator

> A scanner that connects to a live Mirth Connect server and produces a searchable, CIO-ready static catalog of every interface. The artifact every hospital wishes it had but nobody ever maintains.

## What it produces

```
catalog/
├── index.html                     ← searchable, filterable catalog of every interface
├── channels/<channel-slug>.html   ← per-channel detail: source → transformer → destinations
├── MANIFEST.md                    ← Markdown version (renders natively on GitHub)
└── data.json                      ← raw structured data for downstream tooling
```

The HTML output is **self-contained** — no external CSS, no JavaScript frameworks, no API calls at view time. Drop it on GitHub Pages, S3, nginx, or `file://`. It loads instantly even on a hospital VPN.

## Why this matters

Every hospital CIO has been asked "what interfaces do we have?" and nobody can answer without a human clicking through 200 channels. Same question shows up:

- During **audits** (HIPAA, HITRUST, SOC 2) — auditor wants the inventory
- During **change management** — what depends on the channel I'm about to touch?
- During **onboarding** — new integration engineer needs to read the system, not interview people
- During **vendor switches** — to negotiate with payers, labs, EHRs, you have to know what's already wired
- During **incident response** — when a channel breaks, who's downstream?

The Mirth Administrator GUI can't answer any of these at scale. This generator can.

## What each interface page tells you

For every channel:

| Section | What it shows |
|---|---|
| **Message flow diagram** | Source connector → transformer steps → each destination, with config inline (host, port, URL, file path, channel target) |
| **Runtime statistics** | Received / Sent / Filtered / Errored / Queued — pulled live from Mirth |
| **State** | STARTED / STOPPED / PAUSED — color-coded |
| **Sends data to** | Other Mirth channels this channel dispatches to (via Channel Writer) |
| **Consumed by** | Other Mirth channels that send data into this one |
| **Likely code template references** | Heuristic scan of transformer JS for shared helper functions |
| **Clinical classification** | Interface type (ADT, Results, Orders, Pharmacy, Claims, etc.) + clinical impact label |
| **Metadata** | Channel ID, revision, data type, destination count |

## Index page features

- **Live search** — filter by name, description, source connector, destination connector
- **Interface filter** — show only ADT, only Results, only Claims, etc.
- **State filter** — show only STARTED / STOPPED / PAUSED
- **Sortable summary table** — total messages received per clinical domain
- **Hospital-branded header** — passes the `--hospital` argument as the title

---

## Quick start

```bash
pip install -r requirements.txt

python3 catalog.py \
  --mirth-url https://localhost:8443 \
  --user admin \
  --password admin \
  --output ./catalog \
  --hospital "St. Elsewhere Medical Center"

open ./catalog/index.html
```

Re-run any time to refresh. The generator is idempotent — overwrites the output folder cleanly.

### Environment variables (alternative to CLI args)

```bash
export MIRTH_URL=https://mirth.internal:8443
export MIRTH_USER=catalog-reader
export MIRTH_PASS=...
python3 catalog.py --hospital "St. Elsewhere" --output ./catalog
```

### Read-only Mirth user (recommended for production)

Create a read-only user in Mirth Administrator with permission to:
- `GET /api/channels`
- `GET /api/channels/statuses`
- `GET /api/codeTemplates`
- `GET /api/server/version`

No write or admin permissions needed. The catalog never modifies anything.

---

## Publish to GitHub Pages (auto-refresh)

Drop this workflow into `.github/workflows/catalog.yml` of any repo:

```yaml
name: Refresh interface catalog
on:
  schedule: [{ cron: "0 6 * * *" }]   # daily at 06:00 UTC
  workflow_dispatch:

jobs:
  catalog:
    runs-on: self-hosted              # must have network access to Mirth
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r requirements.txt
      - name: Generate catalog
        env:
          MIRTH_URL:  ${{ secrets.MIRTH_URL }}
          MIRTH_USER: ${{ secrets.MIRTH_USER }}
          MIRTH_PASS: ${{ secrets.MIRTH_PASS }}
        run: python3 catalog.py --hospital "${{ vars.HOSPITAL_NAME }}" --output ./site
      - uses: actions/upload-pages-artifact@v3
        with: { path: ./site }
      - uses: actions/deploy-pages@v4
```

Result: every morning at 06:00 UTC the catalog refreshes at `https://<org>.github.io/<repo>/`.

---

## Clinical interface classification

Each channel is classified by name pattern into one of 12 clinical interface types:

| Type | Pattern matches | Clinical impact |
|---|---|---|
| **ADT** | `ADT`, `admission`, `discharge`, `transfer`, `patient reg` | Bed mgmt, registration, census |
| **Orders** | `ORM`, `order entry`, `servicerequest` | Lab/Rad/Pharmacy orders flow |
| **Results** | `ORU`, `result`, `diagnosticreport`, `lab` | Lab/Rad results to chart |
| **Pharmacy** | `RDS`, `RDE`, `pharmacy`, `medication` | Medication safety, MAR |
| **Claims** | `837`, `835`, `270`, `271`, `278`, `claim`, `billing` | Revenue cycle, AR |
| **Scheduling** | `SIU`, `schedul`, `appointment` | OR/clinic scheduling |
| **Documents** | `MDM`, `document`, `note`, `transcrip` | Clinical documentation |
| **Immunization** | `VXU`, `immun`, `vaccin` | Vaccination registry |
| **Data Lake** | `kafka` | Analytics, ML feature store |
| **Clinical Repo** | `openehr`, `composition`, `CDR` | Longitudinal record |
| **FHIR Pipeline** | `fhir` | Downstream FHIR consumers |
| **Routing** | `router`, `smart` | Cross-system message routing |
| **Other** | (none match) | Uncategorized |

Edit `INTERFACE_RULES` in `catalog.py` to match your organization's channel naming convention. The same classification is used by the [hospital-operations-dashboard](../../../docker/hospital-operations-dashboard/) recipe so both views agree on terminology.

---

## Channel-to-channel dependency tracking

The generator inspects every Channel Writer destination and resolves the target channel ID. Each channel detail page then shows:

- **Sends data to** — downstream channels this one dispatches into
- **Consumed by** — upstream channels that feed into this one

This is the closest thing to a data lineage diagram you'll get from Mirth without building one by hand. For full lineage across non-VM destinations (HTTP → external systems, file drops, etc.), the external endpoint is shown in the message flow section.

---

## What this does NOT do (yet — good roadmap items)

1. **Field-level lineage** — "PID-3.1 from EHR → Patient.identifier.value in FHIR Bundle" requires transformer code parsing. Today we show transformer step counts and inbound/outbound data types, not field mappings. A Babel-based JS parser could lift this.
2. **Code template body inspection** — we identify likely helper-function refs by name but don't pull in the actual code template definitions. A second pass calling `/api/codeTemplates` and matching names would close the loop.
3. **Historical change tracking** — the generator produces a snapshot. Wire it into git so each daily run commits diffs and you get change history for free.
4. **Owner / team metadata** — Mirth has no native concept of channel ownership. We surface `description` and `revision` but can't tell you who built it. Solve this with a `tags` convention (e.g., `owner:rcm-team`) and parse them out — easy extension.
5. **Per-channel SLA tracking** — would need timestamp parsing per message. Belongs in the [hospital-operations-dashboard](../../../docker/hospital-operations-dashboard/) extension layer, not the catalog.

---

## Architecture

```
        ┌───────────────────────┐
        │   Mirth Connect       │
        │       :8443           │
        │                       │
        │  /api/channels        │←──── HTTPS GET (XML)
        │  /api/channels/       │
        │     statuses          │
        │  /api/codeTemplates   │
        └───────────────────────┘
                   │
                   ▼
        ┌───────────────────────┐
        │     catalog.py        │
        │                       │
        │  1. Parse channels    │
        │  2. Classify          │
        │  3. Merge stats       │
        │  4. Build dep graph   │
        │  5. Render Jinja      │
        └───────────────────────┘
                   │
                   ▼
        ┌───────────────────────┐
        │  ./catalog/           │
        │    index.html         │     <-- searchable, filterable
        │    channels/*.html    │     <-- one per channel
        │    MANIFEST.md        │     <-- GitHub-native
        │    data.json          │     <-- programmatic
        └───────────────────────┘
```

The output is static. No server, no database, no JavaScript framework. It will keep working in 10 years.

---

## Productionization checklist

Before pointing this at a production Mirth:

- [ ] Create a **read-only Mirth user** (not admin)
- [ ] Store credentials in a **secrets manager**, never in source
- [ ] Validate **TLS certificates** properly (the demo skips cert verification — see `Mirth(...)` constructor in `catalog.py`, remove `verify=False`)
- [ ] Decide on **publish location** — GitHub Pages, internal S3, nginx behind SSO
- [ ] Add **access control** to the catalog itself if it lives behind public DNS (the catalog reveals interface topology — useful intel for attackers)
- [ ] Tune **classification rules** to your channel naming convention
- [ ] Schedule **regular refreshes** via cron or GitHub Actions
- [ ] (Optional) Commit each refresh to git so you have **change history**

---

## File map

```
scripts/operations/interface-catalog-generator/
├── README.md                       this file
├── requirements.txt                requests, urllib3, Jinja2
├── catalog.py                      the generator
├── templates/
│   ├── _base.css                   styling (embedded into every page)
│   ├── index.html.jinja            main catalog page
│   ├── channel.html.jinja          per-channel detail page
│   └── manifest.md.jinja           Markdown manifest
└── examples/
    └── output/                     sample output against the cookbook's demo Mirth
```
