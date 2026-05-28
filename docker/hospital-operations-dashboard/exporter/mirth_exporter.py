#!/usr/bin/env python3
"""
Prometheus exporter for Mirth Connect — Hospital Operations edition.

Beyond raw channel stats, this exporter:
  - Classifies each channel into a clinical interface type (ADT, Orders, Results,
    Pharmacy, Claims, Scheduling, Documents, Data Lake, Clinical Repository)
  - Maps each interface type to a downstream clinical impact area
  - Emits derived metrics aggregated by interface_type so dashboards can speak
    in clinical-operations language, not channel-mechanics language.
"""
import os
import re
import time
import urllib3
import requests
import xml.etree.ElementTree as ET
from collections import defaultdict
from http.server import HTTPServer, BaseHTTPRequestHandler

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MIRTH_URL = os.environ.get("MIRTH_URL", "https://mirth-connect:8443")
MIRTH_USER = os.environ.get("MIRTH_USER", "admin")
MIRTH_PASS = os.environ.get("MIRTH_PASS", "admin")
SCRAPE_TIMEOUT = int(os.environ.get("SCRAPE_TIMEOUT", "10"))


# Channel name → (interface_type, clinical_impact)
# Match in priority order. interface_type drives dashboard grouping.
INTERFACE_RULES = [
    (re.compile(r"\b(ADT|admission|discharge|transfer|patient[_ ]?reg)", re.I),
        ("ADT",            "Bed mgmt, registration, census")),
    (re.compile(r"\bORM\b|order[_ ]?entry|servicerequest", re.I),
        ("Orders",         "Lab/Rad/Pharmacy orders flow")),
    (re.compile(r"\bORU\b|result|diagnosticreport|lab\b", re.I),
        ("Results",        "Lab/Rad results to chart")),
    (re.compile(r"\bRDS\b|\bRDE\b|pharmacy|medication", re.I),
        ("Pharmacy",       "Medication safety, MAR")),
    (re.compile(r"\b837\b|\b835\b|\b270\b|\b271\b|\b278\b|claim|billing|charge", re.I),
        ("Claims",         "Revenue cycle, AR")),
    (re.compile(r"\bSIU\b|schedul|appointment", re.I),
        ("Scheduling",     "OR/clinic scheduling")),
    (re.compile(r"\bMDM\b|document|note|transcrip", re.I),
        ("Documents",      "Clinical documentation")),
    (re.compile(r"\bVXU\b|immun|vaccin", re.I),
        ("Immunization",   "Vaccination registry")),
    (re.compile(r"kafka", re.I),
        ("Data Lake",      "Analytics, ML feature store")),
    (re.compile(r"openehr|composition|CDR", re.I),
        ("Clinical Repo",  "Longitudinal record (openEHR)")),
    (re.compile(r"fhir", re.I),
        ("FHIR Pipeline",  "Downstream FHIR consumers")),
    (re.compile(r"router|smart", re.I),
        ("Routing",        "Cross-system message routing")),
]
DEFAULT_CLASSIFICATION = ("Other", "Uncategorized")


def classify(name: str):
    for pattern, value in INTERFACE_RULES:
        if pattern.search(name):
            return value
    return DEFAULT_CLASSIFICATION


class MirthClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.verify = False
        self.session.headers.update({"X-Requested-With": "OpenAPI"})
        self.authenticated = False

    def login(self):
        r = self.session.post(
            f"{MIRTH_URL}/api/users/_login",
            data={"username": MIRTH_USER, "password": MIRTH_PASS},
            timeout=SCRAPE_TIMEOUT,
        )
        r.raise_for_status()
        self.authenticated = True

    def get_statuses(self):
        if not self.authenticated:
            self.login()
        r = self.session.get(
            f"{MIRTH_URL}/api/channels/statuses",
            headers={"Accept": "application/xml"},
            timeout=SCRAPE_TIMEOUT,
        )
        if r.status_code == 401:
            self.authenticated = False
            self.login()
            r = self.session.get(
                f"{MIRTH_URL}/api/channels/statuses",
                headers={"Accept": "application/xml"},
                timeout=SCRAPE_TIMEOUT,
            )
        r.raise_for_status()
        return r.text


client = MirthClient()

# Tracks last-known received total per channel, to detect freshness.
# Maps channel_id -> (last_total, last_changed_epoch)
_last_seen = {}


def fetch_metrics():
    """Returns Prometheus exposition string."""
    start = time.time()
    now = time.time()
    lines = []

    try:
        xml_text = client.get_statuses()
        root = ET.fromstring(xml_text)

        channels = []
        for ds in root.findall("./dashboardStatus"):
            ch_id = (ds.findtext("channelId") or "").strip()
            ch_name = (ds.findtext("name") or "unknown").strip()
            state = (ds.findtext("state") or "UNKNOWN").strip()

            stats_node = ds.find("statistics")
            stats = {}
            if stats_node is not None:
                for entry in stats_node.findall("entry"):
                    children = list(entry)
                    if len(children) >= 2:
                        key = children[0].text or ""
                        val_text = children[1].text or "0"
                        try:
                            stats[key] = int(val_text)
                        except ValueError:
                            stats[key] = 0

            interface_type, impact = classify(ch_name)
            channels.append((ch_id, ch_name, state, stats, interface_type, impact))

            received = stats.get("RECEIVED", 0)
            last_total, last_changed = _last_seen.get(ch_id, (None, now))
            if last_total is None or received != last_total:
                _last_seen[ch_id] = (received, now)

        # Per-channel state
        lines.append("# HELP mirth_channel_state Channel state (1 for current state)")
        lines.append("# TYPE mirth_channel_state gauge")
        for ch_id, ch_name, state, _, itype, impact in channels:
            for s in ["STARTED", "STOPPED", "PAUSED", "DEPLOYING", "UNDEPLOYING", "UNKNOWN"]:
                v = 1 if s == state else 0
                lines.append(
                    f'mirth_channel_state{{channel_id="{ch_id}",channel="{esc(ch_name)}",'
                    f'interface_type="{esc(itype)}",clinical_impact="{esc(impact)}",state="{s}"}} {v}'
                )

        # Per-channel counters
        for metric, key, mtype, help_text in [
            ("mirth_channel_received_total", "RECEIVED", "counter", "Messages received"),
            ("mirth_channel_sent_total",     "SENT",     "counter", "Messages sent successfully"),
            ("mirth_channel_filtered_total", "FILTERED", "counter", "Messages filtered out"),
            ("mirth_channel_errored_total",  "ERROR",    "counter", "Messages errored"),
            ("mirth_channel_queued",         "QUEUED",   "gauge",   "Messages queued"),
        ]:
            lines.append("")
            lines.append(f"# HELP {metric} {help_text}")
            lines.append(f"# TYPE {metric} {mtype}")
            for ch_id, ch_name, _, stats, itype, impact in channels:
                lines.append(
                    f'{metric}{{channel_id="{ch_id}",channel="{esc(ch_name)}",'
                    f'interface_type="{esc(itype)}",clinical_impact="{esc(impact)}"}} {stats.get(key, 0)}'
                )

        # Seconds since last received message (freshness signal)
        lines.append("")
        lines.append("# HELP mirth_channel_seconds_since_last_message Seconds since exporter last observed a new received message")
        lines.append("# TYPE mirth_channel_seconds_since_last_message gauge")
        for ch_id, ch_name, _, _, itype, impact in channels:
            _, last_changed = _last_seen.get(ch_id, (None, now))
            lines.append(
                f'mirth_channel_seconds_since_last_message{{channel_id="{ch_id}",channel="{esc(ch_name)}",'
                f'interface_type="{esc(itype)}",clinical_impact="{esc(impact)}"}} {int(now - last_changed)}'
            )

        # Interface-type rollups — what hospital ops actually cares about
        rollup = defaultdict(lambda: {"received": 0, "sent": 0, "errored": 0, "queued": 0,
                                       "channels_total": 0, "channels_started": 0})
        for _, _, state, stats, itype, _ in channels:
            r = rollup[itype]
            r["received"]   += stats.get("RECEIVED", 0)
            r["sent"]       += stats.get("SENT", 0)
            r["errored"]    += stats.get("ERROR", 0)
            r["queued"]     += stats.get("QUEUED", 0)
            r["channels_total"] += 1
            if state == "STARTED":
                r["channels_started"] += 1

        lines.append("")
        lines.append("# HELP mirth_interface_messages_received_total Per-clinical-interface received counter")
        lines.append("# TYPE mirth_interface_messages_received_total counter")
        for itype, r in rollup.items():
            lines.append(f'mirth_interface_messages_received_total{{interface_type="{esc(itype)}"}} {r["received"]}')

        lines.append("")
        lines.append("# HELP mirth_interface_messages_errored_total Per-clinical-interface error counter")
        lines.append("# TYPE mirth_interface_messages_errored_total counter")
        for itype, r in rollup.items():
            lines.append(f'mirth_interface_messages_errored_total{{interface_type="{esc(itype)}"}} {r["errored"]}')

        lines.append("")
        lines.append("# HELP mirth_interface_queue_depth Per-clinical-interface queued messages (proxy for patient-impact backlog)")
        lines.append("# TYPE mirth_interface_queue_depth gauge")
        for itype, r in rollup.items():
            lines.append(f'mirth_interface_queue_depth{{interface_type="{esc(itype)}"}} {r["queued"]}')

        lines.append("")
        lines.append("# HELP mirth_interface_channels_started Started channels per clinical interface")
        lines.append("# TYPE mirth_interface_channels_started gauge")
        for itype, r in rollup.items():
            lines.append(f'mirth_interface_channels_started{{interface_type="{esc(itype)}"}} {r["channels_started"]}')

        lines.append("")
        lines.append("# HELP mirth_interface_channels_total Total channels per clinical interface")
        lines.append("# TYPE mirth_interface_channels_total gauge")
        for itype, r in rollup.items():
            lines.append(f'mirth_interface_channels_total{{interface_type="{esc(itype)}"}} {r["channels_total"]}')

        # Exporter health
        lines.append("")
        lines.append("# HELP mirth_exporter_scrape_duration_seconds Time spent scraping Mirth")
        lines.append("# TYPE mirth_exporter_scrape_duration_seconds gauge")
        lines.append(f"mirth_exporter_scrape_duration_seconds {time.time() - start:.4f}")

        lines.append("")
        lines.append("# HELP mirth_exporter_up 1 if scrape succeeded")
        lines.append("# TYPE mirth_exporter_up gauge")
        lines.append("mirth_exporter_up 1")

    except Exception as e:
        lines.append("# HELP mirth_exporter_up 1 if scrape succeeded")
        lines.append("# TYPE mirth_exporter_up gauge")
        lines.append("mirth_exporter_up 0")
        lines.append(f"# Scrape error: {e}")
        client.authenticated = False

    return "\n".join(lines) + "\n"


def esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/metrics":
            body = fetch_metrics().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        if args and "/metrics" in str(args[0]):
            return
        super().log_message(format, *args)


if __name__ == "__main__":
    print(f"Mirth Prometheus exporter starting on :9100, scraping {MIRTH_URL}")
    HTTPServer(("0.0.0.0", 9100), MetricsHandler).serve_forever()
