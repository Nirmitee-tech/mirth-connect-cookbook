#!/usr/bin/env python3
"""
Scenario simulator for the Hospital Operations dashboard.

Each scenario lights up specific panels on the dashboard so the demo tells a
story. Run one scenario at a time; each prints what to watch on Grafana.

Usage:
    python3 run_scenario.py normal
    python3 run_scenario.py burst-results
    python3 run_scenario.py adt-outage
    python3 run_scenario.py claims-eod
    python3 run_scenario.py error-storm
    python3 run_scenario.py mixed-shift   # 5-minute realistic mixed traffic

The dashboard lives at:
    http://localhost:3001/d/hospital-ops/hospital-integration-operations
"""
import argparse
import random
import socket
import sys
import time
from datetime import datetime

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MIRTH_URL = "https://localhost:8443"
USER = "admin"
PASS = "admin"

PORTS = {
    "ADT":     6661,
    "Results": 6671,
    "Orders":  6672,
    "Claims":  6673,
    "Pharmacy": 6674,
}

FIRST_NAMES = ["JANE", "JOHN", "MARIA", "DAVID", "PRIYA", "ALEX", "SOFIA", "WEI", "OMAR", "LINDA"]
LAST_NAMES = ["DOE", "SMITH", "GARCIA", "PATEL", "CHEN", "JOHNSON", "ALI", "RODRIGUEZ", "KIM", "WILLIAMS"]


def hl7_timestamp():
    return datetime.now().strftime("%Y%m%d%H%M%S")


def hl7_msg(msg_type, message_id, valid=True):
    """Produce an HL7v2 message of the requested type. valid=False produces a
    malformed body to drive the error-storm scenario."""
    ts = hl7_timestamp()
    pid = random.randint(10000, 99999)
    first = random.choice(FIRST_NAMES)
    last = random.choice(LAST_NAMES)

    if not valid:
        # MSH header with truncated body — Mirth source will fail to parse
        return f"MSH|^~\\&|EPIC|HOSP|MIRTH|DEMO|{ts}||{msg_type}|{message_id}|P|2.5.1\rBROKEN-PAYLOAD-NO-PROPER-SEGMENTS"

    common = (
        f"MSH|^~\\&|EPIC|HOSP|MIRTH|DEMO|{ts}||{msg_type}|{message_id}|P|2.5.1\r"
        f"EVN|{msg_type.split('^')[-1]}|{ts}\r"
        f"PID|1||MRN{pid}^^^HOSP^MR||{last}^{first}^A||19800101|F\r"
    )

    if msg_type.startswith("ADT"):
        return common + f"PV1|1|I|ICU^101^A|||||||SUR\r"
    if msg_type.startswith("ORU"):
        return common + (
            f"OBR|1|ORD{pid}|LAB{pid}|CBC^Complete Blood Count^L|||{ts}\r"
            f"OBX|1|NM|WBC^WBC^L||7.2|10*3/uL|4.0-11.0|N|||F\r"
        )
    if msg_type.startswith("ORM"):
        return common + (
            f"ORC|NW|ORD{pid}|||||^^^{ts}^^R|||{ts}||DR{pid}^SMITH^J\r"
            f"OBR|1|ORD{pid}||CBC^Complete Blood Count^L\r"
        )
    if msg_type.startswith("RDS"):
        return common + (
            f"ORC|NW|RX{pid}||||||||||DR{pid}^SMITH^J\r"
            f"RXD|1|METFORMIN^^L|{ts}|30|TABS|||||||{pid}\r"
        )
    if msg_type.startswith("DFT"):
        return common + (
            f"PV1|1|O|CLINIC||||||||\r"
            f"FT1|1||{pid}|{ts}||CG|99213^OFFICE VISIT^CPT|||1|150.00\r"
        )
    return common


def send_mllp(port, message_body, timeout=2.0):
    """Open a socket, send one MLLP-framed message, read 1-byte ack, close."""
    payload = b"\x0b" + message_body.encode("utf-8") + b"\x1c\x0d"
    try:
        with socket.create_connection(("localhost", port), timeout=timeout) as sock:
            sock.sendall(payload)
            try:
                sock.recv(1024)
            except socket.timeout:
                pass
        return True
    except (ConnectionRefusedError, socket.timeout, OSError):
        return False


def session():
    s = requests.Session()
    s.verify = False
    s.headers.update({"X-Requested-With": "OpenAPI"})
    r = s.post(f"{MIRTH_URL}/api/users/_login", data={"username": USER, "password": PASS}, timeout=10)
    r.raise_for_status()
    return s


def find_channel_id(s, name_contains):
    r = s.get(f"{MIRTH_URL}/api/channels", headers={"Accept": "application/xml"}, timeout=10)
    import re
    pattern = re.compile(rf"<channel[^>]*>\s*<id>([^<]+)</id>.*?<name>([^<]*{re.escape(name_contains)}[^<]*)</name>", re.DOTALL)
    for cid, cname in pattern.findall(r.text):
        return cid, cname
    return None, None


def stop_channel(s, channel_id):
    s.post(f"{MIRTH_URL}/api/channels/{channel_id}/_stop", timeout=10)


def start_channel(s, channel_id):
    s.post(f"{MIRTH_URL}/api/channels/{channel_id}/_start", timeout=10)


# ── Scenarios ─────────────────────────────────────────────────────────────

def scenario_normal(args):
    """Steady baseline traffic on every interface — dashboard mostly green."""
    print("📋 NORMAL OPERATIONS — 60 seconds of typical hospital traffic.")
    print("   Watch: 'Clinical Message Throughput' fills out with all interface lines.")
    end = time.time() + 60
    counter = 0
    while time.time() < end:
        send_mllp(PORTS["ADT"],     hl7_msg("ADT^A01", f"ADT{counter:05d}"))
        if counter % 2 == 0:
            send_mllp(PORTS["Results"], hl7_msg("ORU^R01", f"ORU{counter:05d}"))
        if counter % 3 == 0:
            send_mllp(PORTS["Orders"],  hl7_msg("ORM^O01", f"ORM{counter:05d}"))
        if counter % 4 == 0:
            send_mllp(PORTS["Pharmacy"], hl7_msg("RDS^O13", f"RDS{counter:05d}"))
        if counter % 5 == 0:
            send_mllp(PORTS["Claims"], hl7_msg("DFT^P03", f"DFT{counter:05d}"))
        counter += 1
        time.sleep(1.5)
    print(f"   ✓ Sent ~{counter} ADT, plus mixed traffic across 4 other interfaces.")


def scenario_burst_results(args):
    """Lab analyzer dumps a batch of 500 results — Results queue spikes."""
    print("🧪 LAB BATCH BURST — 500 ORU results in rapid succession.")
    print("   Watch: 'Lab/Rad Results Backlog' jumps red.")
    print("          'Critical Interface Status' table: Results row moves to top.")
    for i in range(500):
        send_mllp(PORTS["Results"], hl7_msg("ORU^R01", f"BURST{i:04d}"))
        if i % 50 == 0:
            print(f"   ...{i}/500")
    print("   ✓ Burst delivered. Queue will drain over the next ~minute.")


def scenario_adt_outage(args):
    """Stop the ADT channel for 60 seconds — Interfaces Down lights up red,
    incoming registration data backs up at the upstream system."""
    s = session()
    cid, cname = find_channel_id(s, "HL7v2 ADT to FHIR Bundle")
    if not cid:
        sys.exit("Could not find ADT channel to stop")

    print(f"🚨 ADT INTERFACE OUTAGE — stopping '{cname}' for 60s.")
    print("   Watch: 'Interfaces Down' tile flips to red '1'.")
    print("          Critical Interface Status row turns red (no STARTED, no recent msg).")
    print("          'Last Msg (s ago)' for ADT climbs through yellow → red thresholds.")
    stop_channel(s, cid)
    print("   ✓ ADT channel stopped.")

    # In a real outage upstream would queue at their MLLP sender too — but for
    # the demo we'll just wait so the dashboard shows the stale-interface state.
    for remaining in range(60, 0, -10):
        print(f"   ...recovering in {remaining}s")
        time.sleep(10)

    start_channel(s, cid)
    print("   ✓ ADT channel restarted. Watch panels return to green.")


def scenario_claims_eod(args):
    """End-of-day billing batch — 1000 claims in 30 seconds. Realistic for
    hospital billing systems that batch transactions to the clearinghouse."""
    print("💰 END-OF-DAY CLAIMS BATCH — 1000 DFT transactions in 30s.")
    print("   Watch: 'Revenue Cycle Backlog' counts up.")
    print("          'Clinical Message Throughput' Claims line spikes.")
    start = time.time()
    for i in range(1000):
        send_mllp(PORTS["Claims"], hl7_msg("DFT^P03", f"EOD{i:05d}"))
        if i % 100 == 0:
            print(f"   ...{i}/1000  ({time.time()-start:.1f}s elapsed)")
    print(f"   ✓ Batch delivered in {time.time()-start:.1f}s.")


def scenario_error_storm(args):
    """Send 100 malformed messages across all interfaces — Errors panels light
    up. Real-world cause: upstream system pushed messages with bad encoding,
    missing required segments, or a schema mismatch after an EHR upgrade."""
    print("⚠️  ERROR STORM — 100 malformed HL7v2 messages across all interfaces.")
    print("   Watch: 'Interfaces With Errors' tile counts up.")
    print("          Critical Interface Status: Errors column lights up red per interface.")
    interfaces = ["ADT", "Results", "Orders", "Pharmacy", "Claims"]
    msg_types = {"ADT": "ADT^A01", "Results": "ORU^R01", "Orders": "ORM^O01",
                 "Pharmacy": "RDS^O13", "Claims": "DFT^P03"}
    for i in range(100):
        iface = random.choice(interfaces)
        send_mllp(PORTS[iface], hl7_msg(msg_types[iface], f"BAD{i:04d}", valid=False))
        if i % 20 == 0:
            print(f"   ...{i}/100  (last: {iface})")
        time.sleep(0.05)
    print("   ✓ Error storm complete. Check error counters per interface.")


def scenario_mixed_shift(args):
    """5 minutes of realistic mixed traffic with embedded incidents — this is
    the one to record as a demo gif. Patterns through the shift:
      00:00–01:00  normal baseline
      01:00–01:30  morning lab batch (Results spike)
      01:30–02:30  steady
      02:30–02:45  schema mismatch from upstream EHR (error storm)
      02:45–03:30  steady
      03:30–04:30  noon orders rush (Orders spike)
      04:30–04:45  ADT interface flaps (stop/start)
      04:45–05:00  EOD claims batch begins"""
    print("🏥 MIXED SHIFT — 5 minutes of realistic hospital integration traffic.")
    print("   Embedded incidents: lab burst → schema mismatch → orders rush → ADT flap → claims batch.")
    print("   Recommended: open dashboard now and watch the whole story unfold.\n")

    s = session()
    adt_cid, _ = find_channel_id(s, "HL7v2 ADT to FHIR Bundle")

    t0 = time.time()
    counter = 0
    flap_started = False
    while time.time() - t0 < 300:
        elapsed = time.time() - t0

        # Always send some ADT
        send_mllp(PORTS["ADT"], hl7_msg("ADT^A01", f"MIX{counter:05d}"))

        # Phase logic
        if 60 <= elapsed < 90:
            for _ in range(8):
                send_mllp(PORTS["Results"], hl7_msg("ORU^R01", f"LAB{counter:05d}"))
        elif 150 <= elapsed < 165:
            send_mllp(PORTS["Results"], hl7_msg("ORU^R01", f"BAD{counter:05d}", valid=False))
            send_mllp(PORTS["Orders"], hl7_msg("ORM^O01", f"BAD{counter:05d}", valid=False))
        elif 210 <= elapsed < 270:
            for _ in range(4):
                send_mllp(PORTS["Orders"], hl7_msg("ORM^O01", f"NOON{counter:05d}"))
        elif 270 <= elapsed < 280 and not flap_started and adt_cid:
            print(f"   [{int(elapsed)}s] ADT interface flapping...")
            stop_channel(s, adt_cid)
            flap_started = True
        elif 280 <= elapsed < 285 and flap_started and adt_cid:
            start_channel(s, adt_cid)
            print(f"   [{int(elapsed)}s] ADT recovered.")
            flap_started = False
        elif 285 <= elapsed < 300:
            for _ in range(10):
                send_mllp(PORTS["Claims"], hl7_msg("DFT^P03", f"EOD{counter:05d}"))

        # Steady results/pharmacy throughout
        if counter % 3 == 0:
            send_mllp(PORTS["Results"], hl7_msg("ORU^R01", f"BASE{counter:05d}"))
        if counter % 5 == 0:
            send_mllp(PORTS["Pharmacy"], hl7_msg("RDS^O13", f"RX{counter:05d}"))

        counter += 1
        time.sleep(1.5)

    print(f"   ✓ Shift complete. {counter} ADT base + extras delivered.")


SCENARIOS = {
    "normal":         scenario_normal,
    "burst-results":  scenario_burst_results,
    "adt-outage":     scenario_adt_outage,
    "claims-eod":     scenario_claims_eod,
    "error-storm":    scenario_error_storm,
    "mixed-shift":    scenario_mixed_shift,
}


def main():
    parser = argparse.ArgumentParser(description="Mirth scenario simulator")
    parser.add_argument("scenario", choices=list(SCENARIOS.keys()) + ["list"])
    args = parser.parse_args()

    if args.scenario == "list":
        for name, fn in SCENARIOS.items():
            doc = (fn.__doc__ or "").strip().split("\n")[0]
            print(f"  {name:18s}  {doc}")
        return

    print(f"\n→ Dashboard: http://localhost:3001/d/hospital-ops/hospital-integration-operations\n")
    SCENARIOS[args.scenario](args)
    print()


if __name__ == "__main__":
    main()
