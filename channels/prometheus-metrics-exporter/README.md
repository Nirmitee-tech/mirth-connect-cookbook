# Prometheus Metrics Exporter for Mirth Connect

> Native `/metrics` endpoint serving Mirth channel statistics in Prometheus exposition format — no Java agent, no JMX bridge.

## What

A self-contained Mirth channel that:

1. Listens on `GET http://mirth-host:9100/metrics` (HTTP Listener source)
2. Calls Mirth's own REST API (`/api/channels/statuses`) internally
3. Renders the response as Prometheus text-format metrics
4. Returns `Content-Type: text/plain; version=0.0.4`

Drop it into Mirth, point Prometheus at it, get Grafana dashboards.

## Metrics

```
# HELP mirth_channel_received_total Messages received by the source connector
# TYPE mirth_channel_received_total counter
mirth_channel_received_total{channel="HL7 ADT In",channelId="aaaa-..."} 12345

mirth_channel_sent_total{channel="...",channelId="..."}      <counter>
mirth_channel_filtered_total{channel="...",channelId="..."}  <counter>
mirth_channel_errored_total{channel="...",channelId="..."}   <counter>
mirth_channel_queued{channel="...",channelId="..."}          <gauge>
mirth_channel_state{channel="...",channelId="...",state="STARTED"}  <0|1>
mirth_scrape_duration_seconds                                <gauge>
```

## Why

The official Mirth Dashboard ships rich stats but doesn't expose them as Prometheus metrics. Existing solutions:

- Run a separate `mirth-exporter` sidecar that scrapes Mirth's API — extra moving part to operate.
- Use JMX with `jmx_exporter` — works but adds a JVM agent and is fragile across Mirth upgrades.

This recipe runs *inside* Mirth, requires no extra processes, and survives version upgrades because it talks to the documented REST API.

## Where to Install

### Channel Setup

Create a new channel `Prometheus Metrics Exporter` with:

| Section              | Setting                                                                  |
|----------------------|--------------------------------------------------------------------------|
| Source Connector     | `HTTP Listener`                                                          |
| Listener Port        | `9100` (or whatever you want; match your `prometheus.yml` scrape target) |
| Base Context Path    | `/metrics`                                                               |
| Response             | Set "Respond from" → `Source`                                            |
| Response Content Type | `text/plain; version=0.0.4`                                             |
| Source Transformer   | Paste contents of `transformer.js`                                       |

The transformer puts the rendered text into `channelMap.PROM_METRICS`. In the source connector's **Response** field, use a JavaScript step:

```javascript
var status = channelMap.get('PROM_STATUS') || 200;
responseHeaders.put('Content-Type', java.util.Arrays.asList('text/plain; version=0.0.4'));
return ResponseFactory.getSuccessResponse(channelMap.get('PROM_METRICS'));
```

Or simpler — set the source connector "Response Map Variable" to `PROM_METRICS` and the response type to `text/plain`.

### Requirements

The transformer uses Apache HttpClient to call Mirth's REST API. You need the [apache-http-client recipe](../../code-templates/apache-http-client/) installed first:

1. `httpclient-4.5.13.jar` + `httpcore-4.4.13.jar` in `/opt/connect/custom-lib/`
2. `server.includecustomlib = true` in `mirth.properties`
3. Restart Mirth

### Credentials

Set these in `Settings → Configuration Map`:

| Key                   | Value                              |
|-----------------------|------------------------------------|
| `prom.mirth.url`      | `https://localhost:8443/api`       |
| `prom.mirth.user`     | `admin` (or a dedicated read-only) |
| `prom.mirth.password` | `<password>`                       |

Best practice: create a Mirth user with only the `View Dashboard` permission and use those credentials.

## Prometheus Scrape Config

In your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: mirth
    scrape_interval: 30s
    scrape_timeout: 10s
    static_configs:
      - targets: ['mirth-host:9100']
    metrics_path: /metrics
```

## Grafana Dashboard JSON Snippet

Drop this into Grafana → Dashboards → New → Import → "Import via panel JSON" for a starter dashboard:

```json
{
  "title": "Mirth Connect — Channel Throughput",
  "schemaVersion": 39,
  "tags": ["mirth", "hl7", "fhir"],
  "timezone": "browser",
  "panels": [
    {
      "type": "timeseries",
      "title": "Messages Received / sec",
      "gridPos": {"x": 0, "y": 0, "w": 12, "h": 8},
      "targets": [{
        "expr": "sum by (channel) (rate(mirth_channel_received_total[5m]))",
        "legendFormat": "{{channel}}"
      }]
    },
    {
      "type": "timeseries",
      "title": "Messages Sent / sec",
      "gridPos": {"x": 12, "y": 0, "w": 12, "h": 8},
      "targets": [{
        "expr": "sum by (channel) (rate(mirth_channel_sent_total[5m]))",
        "legendFormat": "{{channel}}"
      }]
    },
    {
      "type": "stat",
      "title": "Errored (last hour)",
      "gridPos": {"x": 0, "y": 8, "w": 8, "h": 4},
      "targets": [{
        "expr": "sum by (channel) (increase(mirth_channel_errored_total[1h]))",
        "legendFormat": "{{channel}}"
      }],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "mode": "absolute",
            "steps": [
              {"color": "green", "value": null},
              {"color": "yellow", "value": 1},
              {"color": "red", "value": 10}
            ]
          }
        }
      }
    },
    {
      "type": "gauge",
      "title": "Queued Messages",
      "gridPos": {"x": 8, "y": 8, "w": 8, "h": 4},
      "targets": [{
        "expr": "max by (channel) (mirth_channel_queued)",
        "legendFormat": "{{channel}}"
      }]
    },
    {
      "type": "table",
      "title": "Channel State",
      "gridPos": {"x": 16, "y": 8, "w": 8, "h": 4},
      "targets": [{
        "expr": "mirth_channel_state == 1",
        "instant": true,
        "format": "table"
      }]
    }
  ]
}
```

### Suggested Alerts

```yaml
groups:
  - name: mirth
    rules:
      - alert: MirthChannelStopped
        expr: mirth_channel_state{state="STARTED"} == 0 and on(channel) mirth_channel_state{state="UNDEPLOYED"} == 0
        for: 2m
        annotations:
          summary: "Mirth channel {{ $labels.channel }} not STARTED"

      - alert: MirthChannelQueueGrowing
        expr: max_over_time(mirth_channel_queued[10m]) > 1000
        for: 5m
        annotations:
          summary: "Mirth channel {{ $labels.channel }} has queued > 1000 messages for 5m"

      - alert: MirthChannelErrorsSpiking
        expr: rate(mirth_channel_errored_total[5m]) > 0.1
        for: 5m
        annotations:
          summary: "Mirth channel {{ $labels.channel }} erroring > 0.1/s"
```

## Test Method

```bash
# Once the channel is deployed
curl -s http://mirth-host:9100/metrics | head -40

# Promtool validate
curl -s http://mirth-host:9100/metrics | promtool check metrics

# The formatter itself is tested offline:
node /Users/developer/Desktop/Projects/mirth-connect-cookbook/scripts/testing/test-prometheus-exporter.js
```

The bundled test covers:

- Counter rendering with correct label syntax
- Embedded-quote escaping in channel names (`FHIR "Out"` → `FHIR \"Out\"`)
- One-hot state gauge encoding across all 7 Mirth states
- HELP/TYPE comments
- `mirth_scrape_duration_seconds` gauge present

## Customization

- **Add per-destination metrics**: Mirth's API exposes `/channels/{id}/statistics` per connector. Loop over destinations and emit `mirth_destination_sent_total{channel="X",destination="Y"}`.
- **Add custom labels**: tag channels by environment using a configurationMap prefix lookup — e.g. label every metric with `env="prod"`.
- **Histogram of processing time**: requires extending Mirth statistics — out of scope here.
- **Exclude internal channels**: filter `statuses` array by name prefix (e.g. drop anything starting with `_` or the exporter channel itself).

## Production Considerations

- **Scrape interval ≥ 15s**: each scrape hits Mirth's API which itself walks the in-memory channel registry. 15-30s is plenty.
- **Use a read-only Mirth user**, not `admin`. The exporter only needs `View Dashboard` / `Channel Statistics` permissions.
- **TLS verification disabled by default** because Mirth ships a self-signed cert. For production, either fix the cert and re-enable verification in `mirthApiGet()`, or scope the trust to localhost only.
- **Don't expose `/metrics` to the internet**. Bind the HTTP Listener to `127.0.0.1` and have Prometheus scrape via SSH tunnel, or front it with nginx+basic auth.

## Author

Nirmitee.io — MIT License
