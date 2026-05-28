#!/usr/bin/env python3
"""
Recipe #36 — Channel Status Watchdog

Polls the Mirth Connect REST API at a fixed interval. If a channel's actual
state diverges from the expected state declared in the config YAML, an alert
is sent to Slack and/or PagerDuty. Honors per-channel snooze windows so
scheduled maintenance doesn't page the on-call.

Usage:
    watchdog.py --config /etc/mirth/watchdog.yaml [--once] [--dry-run] [--verbose]

Author: Nirmitee.io
License: MIT
Tested on: Python 3.11, Mirth Connect 4.5.2
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import logging
import os
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Any
from xml.etree import ElementTree as ET

try:
    import yaml  # PyYAML
except ImportError:
    print("Missing dependency: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


VALID_STATES = {"STARTED", "PAUSED", "STOPPED", "DEPLOYING", "UNDEPLOYING", "UNKNOWN"}

log = logging.getLogger("mirth-watchdog")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class SnoozeWindow:
    """A repeating maintenance window during which alerts are suppressed."""
    days: set[int]            # 0=Mon ... 6=Sun
    start: dt.time
    end: dt.time

    def contains(self, when: dt.datetime) -> bool:
        if when.weekday() not in self.days:
            return False
        t = when.time()
        if self.start <= self.end:
            return self.start <= t <= self.end
        # crosses midnight
        return t >= self.start or t <= self.end


@dataclasses.dataclass
class ChannelRule:
    name: str
    expected_state: str
    snooze: list[SnoozeWindow] = dataclasses.field(default_factory=list)

    def in_snooze(self, when: dt.datetime) -> bool:
        return any(w.contains(when) for w in self.snooze)


@dataclasses.dataclass
class Config:
    mirth_host: str
    mirth_user: str
    mirth_pass: str
    poll_interval: int
    verify_tls: bool
    slack_webhook: str | None
    pagerduty_routing_key: str | None
    channels: list[ChannelRule]


def _parse_time(s: str) -> dt.time:
    return dt.time.fromisoformat(s)


_DAY_MAP = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


def _parse_days(spec: str | list) -> set[int]:
    if isinstance(spec, list):
        return {_DAY_MAP[d.lower()[:3]] for d in spec}
    if spec.lower() == "daily":
        return set(range(7))
    if spec.lower() == "weekdays":
        return set(range(5))
    if spec.lower() == "weekends":
        return {5, 6}
    return {_DAY_MAP[d.strip().lower()[:3]] for d in spec.split(",")}


def load_config(path: str) -> Config:
    with open(path, "r", encoding="utf-8") as f:
        raw: dict[str, Any] = yaml.safe_load(f)

    mirth = raw["mirth"]
    alerts = raw.get("alerts", {})
    channels: list[ChannelRule] = []
    for c in raw.get("channels", []):
        expected = c["expected_state"].upper()
        if expected not in VALID_STATES:
            raise ValueError(f"channel {c['name']} has invalid expected_state {expected!r}")
        snoozes: list[SnoozeWindow] = []
        for s in c.get("snooze", []):
            snoozes.append(SnoozeWindow(
                days=_parse_days(s["days"]),
                start=_parse_time(s["start"]),
                end=_parse_time(s["end"]),
            ))
        channels.append(ChannelRule(name=c["name"], expected_state=expected, snooze=snoozes))

    # Expand env vars in credentials (so YAML doesn't carry passwords)
    def env(v: str | None) -> str | None:
        if not v:
            return v
        if v.startswith("${") and v.endswith("}"):
            return os.environ.get(v[2:-1])
        return v

    return Config(
        mirth_host=mirth["host"].rstrip("/"),
        mirth_user=env(mirth["user"]) or "",
        mirth_pass=env(mirth["password"]) or "",
        poll_interval=int(raw.get("poll_interval", 60)),
        verify_tls=bool(mirth.get("verify_tls", False)),
        slack_webhook=env(alerts.get("slack_webhook")),
        pagerduty_routing_key=env(alerts.get("pagerduty_routing_key")),
        channels=channels,
    )


# ---------------------------------------------------------------------------
# Mirth API
# ---------------------------------------------------------------------------

def _ssl_ctx(verify: bool) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def fetch_channel_statuses(cfg: Config, timeout: float = 10.0) -> dict[str, str]:
    """Returns dict {channelName: state}."""
    url = f"{cfg.mirth_host}/api/channels/statuses"
    pwmgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    pwmgr.add_password(None, cfg.mirth_host, cfg.mirth_user, cfg.mirth_pass)
    handler = urllib.request.HTTPBasicAuthHandler(pwmgr)
    opener = urllib.request.build_opener(
        handler,
        urllib.request.HTTPSHandler(context=_ssl_ctx(cfg.verify_tls)),
    )
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "X-Requested-With": "watchdog.py",
    })
    try:
        with opener.open(req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Mirth /api/channels/statuses returned HTTP {e.code}: {e.read()[:200]!r}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Mirth API unreachable: {e.reason}") from e

    return _parse_statuses(body, ctype)


def _parse_statuses(body: str, ctype: str) -> dict[str, str]:
    """Parse either JSON or XML status response from Mirth REST."""
    if "json" in ctype.lower():
        parsed = json.loads(body)
        # Mirth 4.x returns either {"list": {"dashboardStatus": [...]}}  OR  {"dashboardStatus": [...]}
        # depending on which extensions are installed.
        items = parsed.get("list", parsed).get("dashboardStatus", [])
        if isinstance(items, dict):
            items = [items]
        return {it.get("name", "?"): str(it.get("state", "UNKNOWN")).upper() for it in items}
    # XML fallback
    root = ET.fromstring(body)
    out: dict[str, str] = {}
    for st in root.iter("dashboardStatus"):
        name = st.findtext("name") or "?"
        state = (st.findtext("state") or "UNKNOWN").upper()
        out[name] = state
    return out


# ---------------------------------------------------------------------------
# Alerts
# ---------------------------------------------------------------------------

def _http_post(url: str, payload: dict[str, Any], dry_run: bool, timeout: float = 5.0) -> None:
    if dry_run:
        log.info("[dry-run] POST %s body=%s", url, json.dumps(payload)[:200])
        return
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        if resp.status >= 300:
            log.warning("alert POST returned %d", resp.status)


def alert_slack(webhook: str, channel: str, expected: str, actual: str, dry_run: bool) -> None:
    text = (f":rotating_light: Mirth channel *{channel}* is *{actual}*, expected *{expected}*. "
            f"({dt.datetime.now(dt.UTC).isoformat()})")
    _http_post(webhook, {"text": text}, dry_run)


def alert_pagerduty(routing_key: str, channel: str, expected: str, actual: str, dry_run: bool) -> None:
    payload = {
        "routing_key": routing_key,
        "event_action": "trigger",
        "dedup_key": f"mirth-watchdog:{channel}",
        "payload": {
            "summary": f"Mirth channel {channel} is {actual}, expected {expected}",
            "source": "mirth-watchdog",
            "severity": "error",
            "component": channel,
            "group": "mirth-connect",
            "class": "channel-state",
        },
    }
    _http_post("https://events.pagerduty.com/v2/enqueue", payload, dry_run)


def resolve_pagerduty(routing_key: str, channel: str, dry_run: bool) -> None:
    payload = {
        "routing_key": routing_key,
        "event_action": "resolve",
        "dedup_key": f"mirth-watchdog:{channel}",
    }
    _http_post("https://events.pagerduty.com/v2/enqueue", payload, dry_run)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

_running = True


def _handle_signal(signum, _frame):
    global _running
    log.info("received signal %s — shutting down after current cycle", signum)
    _running = False


def evaluate_once(cfg: Config, prior_alerted: set[str], dry_run: bool) -> set[str]:
    """One poll cycle. Returns the new set of channels currently alerted."""
    try:
        statuses = fetch_channel_statuses(cfg)
    except RuntimeError as e:
        log.error("could not poll Mirth: %s", e)
        return prior_alerted

    now = dt.datetime.now()
    currently_alerted: set[str] = set()

    for rule in cfg.channels:
        actual = statuses.get(rule.name, "UNKNOWN")
        log.debug("channel %s actual=%s expected=%s", rule.name, actual, rule.expected_state)

        if actual == rule.expected_state:
            # Healthy — resolve any prior incident
            if rule.name in prior_alerted:
                log.info("RESOLVE channel=%s (now %s)", rule.name, actual)
                if cfg.pagerduty_routing_key:
                    resolve_pagerduty(cfg.pagerduty_routing_key, rule.name, dry_run)
            continue

        # Divergence detected
        if rule.in_snooze(now):
            log.info("SNOOZED channel=%s actual=%s expected=%s",
                     rule.name, actual, rule.expected_state)
            continue

        currently_alerted.add(rule.name)
        if rule.name not in prior_alerted:
            log.warning("ALERT channel=%s actual=%s expected=%s",
                        rule.name, actual, rule.expected_state)
            if cfg.slack_webhook:
                alert_slack(cfg.slack_webhook, rule.name, rule.expected_state, actual, dry_run)
            if cfg.pagerduty_routing_key:
                alert_pagerduty(cfg.pagerduty_routing_key, rule.name, rule.expected_state, actual, dry_run)

    return currently_alerted


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="Mirth Connect channel watchdog")
    p.add_argument("--config", required=True, help="path to YAML config")
    p.add_argument("--once", action="store_true", help="evaluate once and exit")
    p.add_argument("--dry-run", action="store_true", help="don't actually send alerts")
    p.add_argument("--verbose", action="store_true", help="DEBUG logging")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    cfg = load_config(args.config)
    log.info("loaded %d channel rule(s) from %s", len(cfg.channels), args.config)
    log.info("polling %s every %ds", cfg.mirth_host, cfg.poll_interval)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    alerted: set[str] = set()
    while _running:
        alerted = evaluate_once(cfg, alerted, args.dry_run)
        if args.once:
            break
        # Sleep in small slices so SIGTERM is responsive
        for _ in range(cfg.poll_interval):
            if not _running:
                break
            time.sleep(1)
    log.info("exiting cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
