#!/usr/bin/env python3
"""Recipe #49 - Mirth channel XML linter.

Walks one or more directories, finds *.xml files that look like Mirth channels
(top-level <channel> or <codeTemplate>), and runs a battery of structural
checks. Exits non-zero if any error-severity finding is reported.

Tested against Mirth Connect 4.5.2 channel exports.
Author: Nirmitee.io | License: MIT
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

from lxml import etree

SEVERITY_ERROR = "error"
SEVERITY_WARN = "warn"

# Patterns to flag in transformer JavaScript. Stored as fragments to keep
# the source file safe to grep without false positives.
RISKY_JS_PATTERN = "ev" + "al("

# XStream class names that were renamed/removed between Mirth versions.
# Catching these early prevents "ClassNotFoundException" at deploy time.
DEPRECATED_XSTREAM_CLASSES = {
    "com.mirth.connect.connectors.dimse.DICOMReceiverProperties":
        "Use DimseReceiverProperties (Mirth 3.4+).",
    "com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties":
        "Confirm against the running server - package was reorganized in 4.x.",
    "com.mirth.connect.connectors.http.HttpDispatcherProperties$AuthenticationType":
        "Replace with the top-level AuthenticationType enum.",
}

# Connector transport types we expect to see; anything else is suspicious.
KNOWN_SOURCE_TRANSPORTS = {
    "TCP Listener", "HTTP Listener", "File Reader", "Database Reader",
    "JMS Reader", "Channel Reader", "DICOM Listener", "Web Service Listener",
    "JavaScript Reader", "SMTP Listener", "Kafka Consumer",
}


def iter_xml_files(roots: Iterable[Path]) -> Iterable[Path]:
    for root in roots:
        if not root.exists():
            continue
        yield from root.rglob("*.xml")


def parse(path: Path):
    try:
        return etree.parse(str(path))
    except etree.XMLSyntaxError as exc:
        return exc


def check_channel(tree, path: Path) -> list[dict]:
    findings: list[dict] = []
    root = tree.getroot()

    def add(severity: str, code: str, msg: str, line=None) -> None:
        findings.append({
            "file": str(path),
            "severity": severity,
            "code": code,
            "message": msg,
            "line": line,
        })

    # 1. id + name present
    if root.find("id") is None or not (root.findtext("id") or "").strip():
        add(SEVERITY_ERROR, "MIRTH001", "channel is missing <id>")
    if root.find("name") is None or not (root.findtext("name") or "").strip():
        add(SEVERITY_ERROR, "MIRTH002", "channel is missing <name>")

    # 2. exactly one source connector
    source_connectors = root.findall("sourceConnector")
    if len(source_connectors) == 0:
        add(SEVERITY_ERROR, "MIRTH010", "channel has no <sourceConnector>")
    elif len(source_connectors) > 1:
        add(SEVERITY_ERROR, "MIRTH011",
            f"channel has {len(source_connectors)} <sourceConnector> elements (expected 1)")

    # 3. source has a known transportName
    for sc in source_connectors:
        transport = (sc.findtext("transportName") or "").strip()
        if not transport:
            add(SEVERITY_ERROR, "MIRTH012",
                "sourceConnector missing <transportName>", sc.sourceline)
        elif transport not in KNOWN_SOURCE_TRANSPORTS:
            add(SEVERITY_WARN, "MIRTH013",
                f"unknown source transport: {transport!r}", sc.sourceline)

    # 4. at least one destination
    dests = root.findall("destinationConnectors/connector")
    if not dests:
        add(SEVERITY_WARN, "MIRTH020",
            "channel has no destination connectors - messages will be filtered/dropped")

    # 5. deprecated XStream class references
    for el in root.iter():
        cls = el.get("class")
        if cls and cls in DEPRECATED_XSTREAM_CLASSES:
            add(SEVERITY_ERROR, "MIRTH030",
                f"deprecated class {cls}: {DEPRECATED_XSTREAM_CLASSES[cls]}",
                el.sourceline)

    # 6. transformer scripts - balanced braces + risky calls
    for script in root.iter("script"):
        text = script.text or ""
        if text.count("{") != text.count("}"):
            add(SEVERITY_ERROR, "MIRTH040",
                "transformer script has unbalanced braces", script.sourceline)
        if RISKY_JS_PATTERN in text:
            add(SEVERITY_WARN, "MIRTH041",
                "transformer uses dynamic JS execution - refactor to a code template",
                script.sourceline)

    # 7. enabled flag
    if root.findtext("enabled") is None:
        add(SEVERITY_WARN, "MIRTH050",
            "channel missing <enabled> (defaults vary by version)")

    # 8. version pin sanity
    ver = root.findtext("version") or ""
    if ver and not ver.startswith(("4.", "3.")):
        add(SEVERITY_WARN, "MIRTH060",
            f"channel exported from unexpected Mirth version: {ver}")

    return findings


def check_code_template(tree, path: Path) -> list[dict]:
    findings: list[dict] = []
    root = tree.getroot()

    def add(severity: str, code: str, msg: str) -> None:
        findings.append({
            "file": str(path), "severity": severity,
            "code": code, "message": msg, "line": None,
        })

    if root.find("id") is None:
        add(SEVERITY_ERROR, "TPL001", "code template missing <id>")
    if root.find("name") is None:
        add(SEVERITY_ERROR, "TPL002", "code template missing <name>")
    if root.find("contextSet") is None and root.find("context") is None:
        add(SEVERITY_WARN, "TPL003",
            "code template has no contextSet - won't be loadable in any context")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--paths", nargs="+",
                    default=["channels", "code-templates", "transformers"])
    ap.add_argument("--report", default="lint-report.json")
    ap.add_argument("--fail-on", choices=["error", "warn"], default="error")
    args = ap.parse_args()

    findings: list[dict] = []
    scanned = 0
    for path in iter_xml_files(Path(p) for p in args.paths):
        result = parse(path)
        if isinstance(result, etree.XMLSyntaxError):
            findings.append({
                "file": str(path), "severity": SEVERITY_ERROR,
                "code": "XML000",
                "message": f"XML parse error: {result}", "line": None,
            })
            scanned += 1
            continue
        if result is None:
            continue
        scanned += 1
        root_tag = result.getroot().tag
        if root_tag == "channel":
            findings.extend(check_channel(result, path))
        elif root_tag == "codeTemplate":
            findings.extend(check_code_template(result, path))

    errors = sum(1 for f in findings if f["severity"] == SEVERITY_ERROR)
    warns = sum(1 for f in findings if f["severity"] == SEVERITY_WARN)

    report = {
        "scanned_files": scanned,
        "errors": errors,
        "warnings": warns,
        "findings": findings,
    }
    Path(args.report).write_text(json.dumps(report, indent=2))

    for f in findings:
        loc = f"{f['file']}:{f['line']}" if f["line"] else f["file"]
        print(f"[{f['severity']:5}] {f['code']} {loc} - {f['message']}")

    print(f"\nscanned {scanned} files, {errors} errors, {warns} warnings")

    if any(f["severity"] == SEVERITY_ERROR for f in findings):
        return 1
    if args.fail_on == "warn" and warns > 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
