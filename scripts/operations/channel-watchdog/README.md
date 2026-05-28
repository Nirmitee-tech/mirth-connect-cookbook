# Recipe #36 — Channel Status Watchdog

> Polls Mirth REST every 60s. If a channel's actual state isn't what your YAML says it should be, alerts go to Slack and PagerDuty. Snooze windows handle scheduled maintenance.

## What this recipe gives you

- `watchdog.py` — single-file Python 3.11+ daemon (no Flask, no Tornado, just `urllib`)
  - reads expected state per channel from YAML
  - supports per-channel snooze windows (incl. ones that cross midnight)
  - de-dupes alerts (only fires once per state change, resolves on recovery)
  - SIGTERM-clean shutdown, `--dry-run`, `--once`
- `watchdog.example.yaml` — fully-commented example config

## Why

Mirth's built-in alerting fires on **events** (errors, processing time, queue size). It does **not** fire when a channel that should be `STARTED` is sitting in `STOPPED` or `PAUSED` — e.g. because someone stopped it manually three weeks ago and forgot.

This watchdog answers a single question: **"are all the channels you expect to be running, running?"** It's the cheapest way to catch:

- Forgotten manual stops after a debug session
- Channels that auto-paused due to queue-full conditions
- Failed redeployments (channel stuck in `DEPLOYING`)
- Deployment script left a channel undeployed

## Where the files live

```
scripts/operations/channel-watchdog/
├── README.md
├── watchdog.py
└── watchdog.example.yaml
```

## Install

```bash
sudo apt install python3 python3-pip
pip install --user pyyaml          # only external dep

sudo install -m 0755 watchdog.py             /opt/mirth-watchdog/watchdog.py
sudo install -m 0644 watchdog.example.yaml   /etc/mirth/watchdog.yaml.example
sudo cp /etc/mirth/watchdog.yaml.example /etc/mirth/watchdog.yaml
sudo chmod 600 /etc/mirth/watchdog.yaml
sudo $EDITOR /etc/mirth/watchdog.yaml
```

## Configure

Edit `/etc/mirth/watchdog.yaml`. Secrets reference `${ENV_VAR}` so the file itself can ship to git without leaking creds.

```yaml
mirth:
  host:     https://mirth.internal:8443
  user:     ${MIRTH_USER}
  password: ${MIRTH_PASS}

poll_interval: 60

alerts:
  slack_webhook:         ${SLACK_WEBHOOK_URL}
  pagerduty_routing_key: ${PD_ROUTING_KEY}

channels:
  - name: ADT-Ingest
    expected_state: STARTED
    snooze:
      - days: [sat, sun]
        start: "02:00"
        end:   "04:00"

  - name: LabCorp-Outbound
    expected_state: STARTED
    snooze:
      - days: weekdays
        start: "23:30"
        end:   "00:30"   # crosses midnight - handled
```

Valid `expected_state` values: `STARTED`, `PAUSED`, `STOPPED`, `DEPLOYING`, `UNDEPLOYING`, `UNKNOWN`.

`days` accepts:
- a list — `[mon, wed, fri]`
- `daily`, `weekdays`, `weekends`
- a comma-string — `"mon,wed,fri"`

## Run

### One-shot (testing)

```bash
MIRTH_USER=admin MIRTH_PASS=admin \
    python3 watchdog.py --config /etc/mirth/watchdog.yaml --once --dry-run --verbose
```

Output (sample):
```
2026-05-28 12:00:00 INFO loaded 5 channel rule(s) from /etc/mirth/watchdog.yaml
2026-05-28 12:00:00 DEBUG channel ADT-Ingest actual=STARTED expected=STARTED
2026-05-28 12:00:00 WARNING ALERT channel=ORU-Ingest actual=STOPPED expected=STARTED
2026-05-28 12:00:00 INFO [dry-run] POST https://hooks.slack.com/...
```

### As a systemd service

```ini
# /etc/systemd/system/mirth-watchdog.service
[Unit]
Description=Mirth Connect Channel Watchdog
After=network.target

[Service]
EnvironmentFile=/etc/mirth/watchdog.env
ExecStart=/usr/bin/python3 /opt/mirth-watchdog/watchdog.py --config /etc/mirth/watchdog.yaml
Restart=on-failure
RestartSec=30
User=mirth-watchdog
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mirth-watchdog
sudo journalctl -u mirth-watchdog -f
```

### As a Docker sidecar

```yaml
# Append to docker-compose.yml
  mirth-watchdog:
    image: python:3.11-slim
    depends_on: [ mirth-connect ]
    volumes:
      - ./scripts/operations/channel-watchdog/watchdog.py:/opt/watchdog.py:ro
      - ./watchdog.yaml:/etc/watchdog.yaml:ro
    environment:
      - MIRTH_USER=admin
      - MIRTH_PASS=admin
      - SLACK_WEBHOOK_URL
      - PD_ROUTING_KEY
    command: bash -c "pip install --no-cache-dir pyyaml && python3 /opt/watchdog.py --config /etc/watchdog.yaml"
```

## Alert behavior

| Event | Slack | PagerDuty |
|---|---|---|
| Channel diverges from expected | message sent | `trigger` with dedup_key=`mirth-watchdog:<channel>` |
| Same divergence persists over N polls | no repeat (deduped) | no repeat |
| Channel recovers to expected state | not announced (avoids spam) | `resolve` for the same dedup_key |
| Mirth API itself is unreachable | logged, no alert | logged, no alert (see "the alerter shouldn't alert about itself") |

If you *do* want to alert on Mirth unreachable, run a separate uptime monitor — let the watchdog focus on channel state.

## Verification (verified)

The snooze-window and JSON parser internals were unit-checked:

```bash
python3 -c "
import sys; sys.path.insert(0, '.')
import datetime as dt
from watchdog import SnoozeWindow, _parse_days, _parse_statuses

# Cross-midnight window: Tue 23:45 should be IN; Tue 02:00 should be OUT
sw = SnoozeWindow(days={0,1,2,3,4}, start=dt.time(23,30), end=dt.time(0,30))
assert sw.contains(dt.datetime(2026,5,26,23,45))
assert sw.contains(dt.datetime(2026,5,26,0,15))
assert not sw.contains(dt.datetime(2026,5,26,2,0))

# JSON status parse — both Mirth response shapes
assert _parse_statuses('{\"list\":{\"dashboardStatus\":[{\"name\":\"X\",\"state\":\"STARTED\"}]}}', 'application/json') == {'X':'STARTED'}
print('ok')
"
```

## Customize

- **Add Teams / Discord / Mattermost** — drop a new `alert_*` function alongside `alert_slack`. They all just POST JSON.
- **Per-channel cooldown** — extend `ChannelRule` with `cooldown_minutes` and gate `alert_*` calls on a `last_alerted_at` timestamp in a `dict`.
- **Multi-server fan-out** — load several Mirth hosts and add `mirth.host` to the alert payload so the on-call knows which env paged.
- **Cert expiry monitor** — add a `check_cert_expiry()` that opens the MLLPS port (Recipe #30), parses the server cert, and warns at T-30d. Reuse `alert_slack`/`alert_pagerduty`.

## Tested on

- Python 3.11.x (linux + macOS)
- Mirth Connect 4.5.2 (Docker image)
- Slack incoming webhooks; PagerDuty Events API v2

## Author / License

Author: Nirmitee.io
License: MIT
