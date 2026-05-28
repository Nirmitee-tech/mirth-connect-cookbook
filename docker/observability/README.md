# Recipe #37 — Loki Log Aggregation for Mirth Connect

> Drop-in observability stack: Mirth logs flow through Promtail into Loki, with a pre-built Grafana dashboard for error counts, per-channel breakdowns, and full log search.

## What this recipe gives you

| File | Purpose |
|---|---|
| `docker-compose-loki.yml`              | Adds `loki`, `promtail`, `grafana` services to the existing stack |
| `loki-config.yaml`                     | Single-node Loki config (TSDB, 30-day retention) |
| `promtail-config.yaml`                 | Tails Mirth log files and parses channel ID / level |
| `log4j2.xml`                           | Drop-in Mirth log4j2 config that emits a channel-aware log file |
| `grafana-datasources.yaml`             | Provisions the Loki datasource on Grafana boot |
| `grafana-dashboard-provisioning.yaml`  | Picks up the dashboard JSON |
| `grafana-dashboard.json`               | "Mirth Connect — Logs" dashboard with error counts, top channels, log stream |

## Why

`docker logs mirth-connect` only goes back as far as your Docker log driver remembers and is unsearchable. `kubectl logs` is no better. Once you've spent 20 minutes `grep`-ing for `Caused by` across yesterday's rotated files, you'll want Loki.

Loki is the right pick for Mirth specifically because:
- Mirth log lines are noisy and high-cardinality (channel id, message id) — Loki indexes only labels, so it stays cheap
- It speaks LogQL, which is easy to alert on (Recipe #36 can be wired to it)
- Grafana is already in most ops stacks

## Where the files live

```
docker/observability/
├── README.md
├── docker-compose-loki.yml
├── loki-config.yaml
├── promtail-config.yaml
├── log4j2.xml                                <-- copy onto the Mirth host
├── grafana-datasources.yaml
├── grafana-dashboard-provisioning.yaml
└── grafana-dashboard.json
```

## 1. Wire log4j2 inside Mirth

```bash
# Inside the Mirth container (or bake into your image)
docker cp docker/observability/log4j2.xml mirth-connect:/opt/connect/conf/log4j2.xml

# Mirth 4.5.2 ships log4j2 — the file path is /opt/connect/conf/log4j2.properties by default.
# Renaming to log4j2.xml takes precedence (log4j2 picks .xml > .yaml > .json > .properties).
docker restart mirth-connect
```

This emits three log files into `/opt/connect/logs/` inside the container (mounted as the `mirth-appdata` volume):

| File | What's in it |
|---|---|
| `mirth.log`              | everything at INFO+ |
| `mirth-channels.log`     | per-channel lines stamped with `channel=<id> msg=<id>` |
| `mirth-error.log`        | ERROR-and-above only (separate file = simpler retention) |

## 2. Bring up the stack

```bash
cd docker/
docker compose -f docker-compose.yml -f observability/docker-compose-loki.yml up -d
```

Wait ~30s, then check:

```bash
curl -s http://localhost:3100/ready                       # loki
curl -s http://localhost:9080/ready                       # promtail
open http://localhost:3000                                # grafana (admin/admin)
```

## 3. Open the dashboard

Grafana -> Dashboards -> Mirth Connect -> **Mirth Connect — Logs**.

Panels:
- **Log volume by level** — bars per `level` label
- **Errors per channel (top 10)** — which channels are noisiest right now
- **Total errors (1h)** — stat panel for the on-call glance
- **Active channels logging** — sanity-check that nothing's gone silent
- **Top error messages** — table of `channel_id` x error count
- **Channel log stream** — live tail, filtered by the `channel_id` + `level` template variables

## 4. Useful LogQL queries

Paste these into Grafana's Explore tab.

```logql
# Everything from one channel
{job="mirth", stream="channel", channel_id="ADT-Ingest"}

# Find a specific message
{job="mirth", stream="channel"} |~ "msg=12345"

# Error rate by channel over the last 5m
sum by (channel_id) (rate({job="mirth", level="ERROR"} [5m]))

# Find the most common error message text
topk(20, sum by (message) (count_over_time({job="mirth", level="ERROR"} [1h] | pattern `<_> <message>`)))

# Throughput drop alarm — channel went silent
absent_over_time({job="mirth", stream="channel", channel_id="ADT-Ingest"}[5m])

# Trend: error count week over week
sum(count_over_time({job="mirth", level="ERROR"}[1h]))

# All HTTP destination failures (combine with Recipe #9)
{job="mirth"} |~ "HTTP \\d{3}" | regexp "HTTP (?P<status>\\d{3})" | status >= 500
```

## 5. Verification (verified)

```bash
# YAML lint
python3 -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]" \
    docker/observability/loki-config.yaml \
    docker/observability/promtail-config.yaml \
    docker/observability/grafana-datasources.yaml \
    docker/observability/grafana-dashboard-provisioning.yaml \
    docker/observability/docker-compose-loki.yml

# Dashboard JSON lint
node -e "JSON.parse(require('fs').readFileSync('docker/observability/grafana-dashboard.json','utf8')); console.log('ok')"
```

## 6. Production hardening

- **Retention** — `limits_config.retention_period: 720h` in `loki-config.yaml`. For SIEM-grade retention (6 years HIPAA, audit log), use a separate Loki tenant with object storage (S3 / GCS) and `chunk_target_size: 1572864`.
- **PHI in logs** — combine with Recipe #31 (PHI masking). Set `phi.masking.enabled=true` for any environment whose logs land in Loki, unless your Loki bucket is a BAA-covered service.
- **Auth on the Loki API** — front Loki + Grafana with an authenticating reverse proxy (Caddy + OIDC works well). The compose file does NOT expose Loki authentication — fine for local, not for prod.
- **High cardinality footgun** — never label by `message_id` or `patient_id`. They're parsed out and available for filtering but stay in the log line, not the label set.
- **Alerts** — Loki Ruler can fire alerts via Alertmanager. Wire Recipe #36's PagerDuty key in for hybrid alerting (state from Mirth REST + content from Loki).

## 7. Customize

- **Add stdout JSON logging** — change `PATTERN_SERVER` in `log4j2.xml` to a JSON layout (`JsonTemplateLayout`) so structured fields land as Loki structured metadata.
- **Multi-server** — point Promtail at multiple log dirs and add a `server` label.
- **Tempo for traces** — add a third service if you ever wire OpenTelemetry into Mirth transformers.

## Tested on

- Loki 3.0, Promtail 3.0, Grafana 11.0
- Mirth Connect 4.5.2 (log4j2 2.x)
- Docker Compose v2

## Author / License

Author: Nirmitee.io
License: MIT
