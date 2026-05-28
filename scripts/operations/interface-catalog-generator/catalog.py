#!/usr/bin/env python3
"""
Interface Catalog Generator for Mirth Connect.

Connects to a running Mirth Connect server, extracts every channel's
configuration and runtime statistics, classifies each channel into a
clinical interface type, traces channel-to-channel dependencies, and
produces a searchable static catalog (HTML + JSON + Markdown).

Run:
    pip install -r requirements.txt
    python3 catalog.py \
        --mirth-url https://localhost:8443 \
        --user admin --password admin \
        --output ./catalog \
        --hospital "Sample Hospital"

Then open ./catalog/index.html — or publish to GitHub Pages /S3 / nginx.
"""
import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import requests
import urllib3
from jinja2 import Environment, FileSystemLoader, select_autoescape

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


# ── Clinical interface classification ─────────────────────────────────────
# Identical to the dashboard exporter so both views agree on terminology.
INTERFACE_RULES = [
    (re.compile(r"\b(ADT|admission|discharge|transfer|patient[_ ]?reg)", re.I),
        ("ADT", "Bed mgmt, registration, census")),
    (re.compile(r"\bORM\b|order[_ ]?entry|servicerequest", re.I),
        ("Orders", "Lab/Rad/Pharmacy orders flow")),
    (re.compile(r"\bORU\b|result|diagnosticreport|lab\b", re.I),
        ("Results", "Lab/Rad results to chart")),
    (re.compile(r"\bRDS\b|\bRDE\b|pharmacy|medication", re.I),
        ("Pharmacy", "Medication safety, MAR")),
    (re.compile(r"\b837\b|\b835\b|\b270\b|\b271\b|\b278\b|claim|billing|charge", re.I),
        ("Claims", "Revenue cycle, AR")),
    (re.compile(r"\bSIU\b|schedul|appointment", re.I),
        ("Scheduling", "OR/clinic scheduling")),
    (re.compile(r"\bMDM\b|document|note|transcrip", re.I),
        ("Documents", "Clinical documentation")),
    (re.compile(r"\bVXU\b|immun|vaccin", re.I),
        ("Immunization", "Vaccination registry")),
    (re.compile(r"kafka", re.I),
        ("Data Lake", "Analytics, ML feature store")),
    (re.compile(r"openehr|composition|CDR", re.I),
        ("Clinical Repo", "Longitudinal record (openEHR)")),
    (re.compile(r"fhir", re.I),
        ("FHIR Pipeline", "Downstream FHIR consumers")),
    (re.compile(r"router|smart", re.I),
        ("Routing", "Cross-system message routing")),
]


def classify(name):
    for pattern, value in INTERFACE_RULES:
        if pattern.search(name or ""):
            return value
    return ("Other", "Uncategorized")


# ── Connector-type humanization ───────────────────────────────────────────
CONNECTOR_TYPES = {
    "com.mirth.connect.connectors.tcp.TcpReceiverProperties":      "MLLP / TCP Listener",
    "com.mirth.connect.connectors.tcp.TcpDispatcherProperties":    "MLLP / TCP Sender",
    "com.mirth.connect.connectors.http.HttpReceiverProperties":    "HTTP Listener",
    "com.mirth.connect.connectors.http.HttpDispatcherProperties":  "HTTP Sender",
    "com.mirth.connect.connectors.file.FileReceiverProperties":    "File Reader",
    "com.mirth.connect.connectors.file.FileDispatcherProperties":  "File Writer",
    "com.mirth.connect.connectors.jdbc.DatabaseReceiverProperties": "Database Reader",
    "com.mirth.connect.connectors.jdbc.DatabaseDispatcherProperties": "Database Writer",
    "com.mirth.connect.connectors.jms.JmsReceiverProperties":      "JMS Listener",
    "com.mirth.connect.connectors.jms.JmsDispatcherProperties":    "JMS Sender",
    "com.mirth.connect.connectors.vm.VmReceiverProperties":        "Channel Reader",
    "com.mirth.connect.connectors.vm.VmDispatcherProperties":      "Channel Writer",
    "com.mirth.connect.connectors.smtp.SmtpDispatcherProperties":  "SMTP Sender",
    "com.mirth.connect.connectors.js.JavaScriptReceiverProperties": "JavaScript Reader",
    "com.mirth.connect.connectors.js.JavaScriptDispatcherProperties": "JavaScript Writer",
    "com.mirth.connect.connectors.doc.DocumentDispatcherProperties": "Document Writer",
    "com.mirth.connect.connectors.dimse.DICOMReceiverProperties":  "DICOM Listener",
    "com.mirth.connect.connectors.dimse.DICOMDispatcherProperties": "DICOM Sender",
    "com.mirth.connect.connectors.ws.WebServiceReceiverProperties": "Web Service Listener",
    "com.mirth.connect.connectors.ws.WebServiceDispatcherProperties": "Web Service Sender",
}


def humanize_connector(class_name):
    return CONNECTOR_TYPES.get(class_name, class_name.split(".")[-1].replace("Properties", ""))


# ── Mirth REST API client ─────────────────────────────────────────────────
class Mirth:
    def __init__(self, url, user, password, verify=False):
        self.url = url.rstrip("/")
        self.session = requests.Session()
        self.session.verify = verify
        self.session.headers.update({"X-Requested-With": "OpenAPI"})
        r = self.session.post(
            f"{self.url}/api/users/_login",
            data={"username": user, "password": password},
            timeout=15,
        )
        r.raise_for_status()

    def _xml_get(self, path):
        r = self.session.get(
            f"{self.url}{path}",
            headers={"Accept": "application/xml"},
            timeout=30,
        )
        r.raise_for_status()
        return r.text

    def channels_xml(self):
        return self._xml_get("/api/channels")

    def statuses_xml(self):
        return self._xml_get("/api/channels/statuses")

    def code_templates_xml(self):
        try:
            return self._xml_get("/api/codeTemplates")
        except Exception:
            return None

    def server_info(self):
        try:
            r = self.session.get(
                f"{self.url}/api/server/version",
                headers={"Accept": "text/plain"},
                timeout=10,
            )
            return r.text.strip()
        except Exception:
            return "unknown"


# ── Channel extraction ────────────────────────────────────────────────────

def text(node, tag, default=""):
    el = node.find(tag) if node is not None else None
    return (el.text or default).strip() if el is not None and el.text else default


def extract_listener(props_node):
    """Pull host/port from listenerConnectorProperties when present."""
    lc = props_node.find("listenerConnectorProperties")
    if lc is None:
        return None
    return {"host": text(lc, "host", "0.0.0.0"), "port": text(lc, "port", "?")}


def extract_http(props_node, is_source):
    """Pull URL/method from HTTP receiver/dispatcher."""
    if is_source:
        ctx = text(props_node, "contextPath")
        port = (props_node.find("listenerConnectorProperties") or ET.Element("x")).findtext("port", "?")
        return {"path": f":{port}{ctx}" if ctx else f":{port}"}
    return {
        "url": text(props_node, "host"),
        "method": text(props_node, "method", "GET"),
    }


def extract_file(props_node):
    return {
        "scheme": text(props_node, "scheme"),
        "host": text(props_node, "host"),
        "directory": text(props_node, "directory"),
    }


def extract_db(props_node):
    return {
        "driver": text(props_node, "driver"),
        "url": text(props_node, "url"),
    }


def extract_vm(props_node):
    """Channel Writer destinations carry the target channel ID."""
    return {"channel_id": text(props_node, "channelId", "none")}


def extract_connector_summary(props_node, is_source):
    if props_node is None:
        return {"type": "Unknown", "details": {}}
    cls = props_node.get("class", "")
    summary = {"type": humanize_connector(cls), "class": cls, "details": {}}

    if "tcp.Tcp" in cls and is_source:
        summary["details"].update(extract_listener(props_node) or {})
    elif "tcp.Tcp" in cls and not is_source:
        summary["details"]["host"] = text(props_node, "remoteAddress")
        summary["details"]["port"] = text(props_node, "remotePort")
    elif "http.Http" in cls:
        summary["details"].update(extract_http(props_node, is_source))
    elif "file.File" in cls:
        summary["details"].update(extract_file(props_node))
    elif "jdbc.Database" in cls:
        summary["details"].update(extract_db(props_node))
    elif "vm.Vm" in cls and not is_source:
        summary["details"].update(extract_vm(props_node))

    return summary


def transformer_summary(node):
    """Summarize a transformer block — element count and inbound/outbound data types."""
    if node is None:
        return None
    elements = node.find("elements")
    count = 0 if elements is None else sum(1 for _ in elements)
    return {
        "elements": count,
        "inbound": text(node, "inboundDataType", "RAW"),
        "outbound": text(node, "outboundDataType", "RAW"),
    }


def filter_summary(node):
    if node is None:
        return None
    elements = node.find("elements")
    count = 0 if elements is None else sum(1 for _ in elements)
    return {"rules": count}


def find_code_template_refs(xml_text):
    """Heuristic: scan transformer JS bodies for code-template function refs.
    Code templates are typically called as global functions like `auditLog(...)`,
    so we can at least flag candidate dependencies by name pattern."""
    refs = set()
    # XStream serializes JS in CDATA-ish blocks under <script> tags inside transformers.
    for match in re.finditer(r"<script>(.*?)</script>", xml_text, re.DOTALL):
        body = match.group(1)
        # Plausible code-template helper names: camelCase identifiers used as functions
        for fn_match in re.finditer(r"\b([a-z][a-zA-Z0-9]+)\s*\(", body):
            name = fn_match.group(1)
            # Skip JS built-ins and Mirth standard globals
            if name in {"function", "var", "if", "for", "while", "return", "new",
                        "typeof", "console", "logger", "channel", "msg", "tmp",
                        "globalMap", "channelMap", "responseMap", "configurationMap",
                        "alerts", "router", "destinationSet", "ResponseFactory",
                        "Packages", "JSON", "String", "Number", "Boolean", "Object",
                        "Array", "Math", "Date", "parseInt", "parseFloat", "isNaN",
                        "isFinite", "encodeURI", "decodeURI", "encodeURIComponent",
                        "decodeURIComponent", "RegExp", "Error", "TypeError"}:
                refs.add(name)
    return sorted(refs)


def parse_channels(channels_xml):
    """Return a list of channel dicts with the catalog metadata."""
    root = ET.fromstring(channels_xml)
    channels = []
    for ch in root.findall("./channel"):
        cid = text(ch, "id")
        name = text(ch, "name", "(unnamed)")
        description = text(ch, "description")
        revision = text(ch, "revision", "0")
        interface_type, clinical_impact = classify(name)

        # Source
        src = ch.find("sourceConnector")
        src_props = src.find("properties") if src is not None else None
        source = extract_connector_summary(src_props, is_source=True)
        source["transformer"] = transformer_summary(src.find("transformer") if src is not None else None)
        source["filter"] = filter_summary(src.find("filter") if src is not None else None)
        source["data_type"] = text(src_props, "format") if src_props is not None else "?"

        # Destinations
        destinations = []
        dest_root = ch.find("destinationConnectors")
        if dest_root is not None:
            for dst in dest_root.findall("connector"):
                dst_props = dst.find("properties")
                d = extract_connector_summary(dst_props, is_source=False)
                d["name"] = text(dst, "name", "Destination")
                d["transformer"] = transformer_summary(dst.find("transformer"))
                d["enabled"] = text(dst, "enabled", "true") == "true"
                destinations.append(d)

        # Find code-template references via heuristic
        # We feed only this channel's serialized XML
        channel_xml_text = ET.tostring(ch, encoding="unicode")
        code_refs = find_code_template_refs(channel_xml_text)

        channels.append({
            "id": cid,
            "name": name,
            "description": description,
            "revision": revision,
            "interface_type": interface_type,
            "clinical_impact": clinical_impact,
            "source": source,
            "destinations": destinations,
            "code_template_refs": code_refs,
            "state": "UNKNOWN",
            "stats": {"received": 0, "sent": 0, "filtered": 0, "errored": 0, "queued": 0},
        })

    return channels


def merge_statuses(channels, statuses_xml):
    root = ET.fromstring(statuses_xml)
    by_id = {c["id"]: c for c in channels}

    for ds in root.findall("./dashboardStatus"):
        cid = text(ds, "channelId")
        if cid not in by_id:
            continue
        ch = by_id[cid]
        ch["state"] = text(ds, "state", "UNKNOWN")
        stats_node = ds.find("statistics")
        if stats_node is not None:
            for entry in stats_node.findall("entry"):
                kids = list(entry)
                if len(kids) >= 2:
                    key = kids[0].text or ""
                    val = kids[1].text or "0"
                    try:
                        val = int(val)
                    except ValueError:
                        val = 0
                    mapping = {"RECEIVED": "received", "SENT": "sent",
                               "FILTERED": "filtered", "ERROR": "errored",
                               "QUEUED": "queued"}
                    if key in mapping:
                        ch["stats"][mapping[key]] = val


def build_dependency_graph(channels):
    """Identify channel→channel edges via Channel Writer destinations.
    Each Channel Writer carries a target channel ID in details.channel_id.
    Adds both 'consumes_from' and 'sends_to' arrays per channel."""
    by_id = {c["id"]: c for c in channels}
    for c in channels:
        c["sends_to"] = []
        c["consumed_by"] = []

    for c in channels:
        for d in c["destinations"]:
            target = d.get("details", {}).get("channel_id")
            if target and target != "none" and target in by_id:
                target_name = by_id[target]["name"]
                c["sends_to"].append({"id": target, "name": target_name, "via": d["name"]})
                by_id[target]["consumed_by"].append({"id": c["id"], "name": c["name"], "via": d["name"]})


def render_catalog(channels, output_dir, hospital_name, mirth_url, mirth_version):
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "channels").mkdir(exist_ok=True)

    here = Path(__file__).parent
    env = Environment(
        loader=FileSystemLoader(str(here / "templates")),
        autoescape=select_autoescape(["html", "xml"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )

    interface_totals = defaultdict(lambda: {"channels": 0, "received": 0, "errored": 0, "queued": 0})
    for c in channels:
        i = interface_totals[c["interface_type"]]
        i["channels"] += 1
        i["received"] += c["stats"]["received"]
        i["errored"] += c["stats"]["errored"]
        i["queued"] += c["stats"]["queued"]

    summary = {
        "hospital": hospital_name,
        "mirth_url": mirth_url,
        "mirth_version": mirth_version,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "channel_count": len(channels),
        "started_count": sum(1 for c in channels if c["state"] == "STARTED"),
        "interfaces": dict(interface_totals),
    }

    # Sort: started first, then by queue depth desc, then name
    channels.sort(key=lambda c: (c["state"] != "STARTED", -c["stats"]["queued"], c["name"]))

    index_html = env.get_template("index.html.jinja").render(
        summary=summary,
        channels=channels,
    )
    (out / "index.html").write_text(index_html)

    detail_tmpl = env.get_template("channel.html.jinja")
    for c in channels:
        slug = re.sub(r"[^a-zA-Z0-9-]+", "-", c["name"]).strip("-").lower()
        (out / "channels" / f"{slug}.html").write_text(detail_tmpl.render(channel=c, summary=summary))
        c["slug"] = slug

    md_tmpl = env.get_template("manifest.md.jinja")
    (out / "MANIFEST.md").write_text(md_tmpl.render(summary=summary, channels=channels))

    (out / "data.json").write_text(json.dumps({"summary": summary, "channels": channels}, indent=2))

    print(f"\n✓ Catalog generated at {out.resolve()}")
    print(f"  • {summary['channel_count']} channels  ({summary['started_count']} STARTED)")
    print(f"  • {len(summary['interfaces'])} clinical interface types")
    print(f"  • Open file://{(out / 'index.html').resolve()}")


def main():
    parser = argparse.ArgumentParser(description="Mirth Connect Interface Catalog Generator")
    parser.add_argument("--mirth-url", default=os.environ.get("MIRTH_URL", "https://localhost:8443"))
    parser.add_argument("--user", default=os.environ.get("MIRTH_USER", "admin"))
    parser.add_argument("--password", default=os.environ.get("MIRTH_PASS", "admin"))
    parser.add_argument("--output", default="./catalog")
    parser.add_argument("--hospital", default="Sample Hospital")
    args = parser.parse_args()

    print(f"Connecting to {args.mirth_url} as {args.user}...")
    m = Mirth(args.mirth_url, args.user, args.password)
    version = m.server_info()
    print(f"  Mirth version: {version}")

    print("Fetching channel configurations...")
    channels = parse_channels(m.channels_xml())
    print(f"  Found {len(channels)} channels")

    print("Fetching runtime statuses...")
    merge_statuses(channels, m.statuses_xml())

    print("Resolving channel-to-channel dependencies...")
    build_dependency_graph(channels)

    print("Rendering catalog...")
    render_catalog(channels, args.output, args.hospital, args.mirth_url, version)


if __name__ == "__main__":
    main()
