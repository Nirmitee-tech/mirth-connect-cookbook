#!/usr/bin/env python3
"""
send-test-hl7v2.py — Send sample HL7v2 messages to a Mirth MLLP listener.

Usage:
    python3 send-test-hl7v2.py --port 6661 --message-type ADT_A01
    python3 send-test-hl7v2.py --port 6661 --message-type ORU_R01
    python3 send-test-hl7v2.py --port 6661 --message-type SIU_S12
    python3 send-test-hl7v2.py --port 6661 --message-type MDM_T02

Supported message types:
    ADT_A01  - Admission
    ADT_A03  - Discharge
    ADT_A04  - Registration
    ADT_A08  - Update
    ORM_O01  - Order
    ORU_R01  - Lab result
    SIU_S12  - Appointment
    MDM_T02  - Document notification

Author: Nirmitee.io | License: MIT
"""

import argparse
import socket
import sys
import time
from datetime import datetime


MLLP_START = b'\x0b'  # Vertical Tab
MLLP_END = b'\x1c\x0d'  # File Separator + Carriage Return


SAMPLES = {
    "ADT_A01": (
        "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||ADT^A01|MSG{ts}|P|2.5.1\r"
        "EVN|A01|{ts}\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M|||123 Main St^^Boston^MA^02108^US||617-555-1234|||S\r"
        "PV1|1|I|ICU^301^A|E|||DR100^Lee^Andrew|||MED||||7|||DR100^Lee^Andrew|IP|V12345|||||||||||||||||||||||||{ts}\r"
        "IN1|1||BCBS|Blue Cross Blue Shield|||||||GRP-100\r"
        "DG1|1||A41.9^Sepsis, unspecified organism^ICD10||{date}|A\r"
    ),
    "ADT_A03": (
        "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||ADT^A03|MSG{ts}|P|2.5.1\r"
        "EVN|A03|{ts}\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M|||123 Main St^^Boston^MA^02108^US||617-555-1234|||S\r"
        "PV1|1|I|ICU^301^A|E|||DR100^Lee^Andrew|||MED|DC||||7|||DR100^Lee^Andrew|IP|V12345||||||||||||||||||||||{ts}|{ts}\r"
    ),
    "ADT_A04": (
        "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||ADT^A04|MSG{ts}|P|2.5.1\r"
        "EVN|A04|{ts}\r"
        "PID|1||PAT-67890^^^MGH^MR||Doe^Jane^M||19920720|F|||456 Oak Ave^^Chicago^IL^60601^US||312-555-9876|||S\r"
        "PV1|1|O|CLINIC^102^B|R|||DR200^Kumar^Anil|||AMB||||7|||DR200^Kumar^Anil|OP|V67890\r"
    ),
    "ADT_A08": (
        "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||ADT^A08|MSG{ts}|P|2.5.1\r"
        "EVN|A08|{ts}\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M|||123 Main St^^Boston^MA^02108^US||617-555-1234|||M\r"
        "PV1|1|I|ICU^301^A|E|||DR100^Lee^Andrew|||MED||||7|||DR100^Lee^Andrew|IP|V12345\r"
    ),
    "ORM_O01": (
        "MSH|^~\\&|EPIC|MGH|LIS|LAB|{ts}||ORM^O01|MSG{ts}|P|2.5.1\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M\r"
        "PV1|1|I|ICU^301^A|||||DR100^Lee^Andrew\r"
        "ORC|NW|ORD-001|||IP|||||{ts}|||DR100^Lee^Andrew\r"
        "OBR|1|ORD-001||CBC^Complete Blood Count^L|||{ts}|||||||||||||||||F\r"
    ),
    "ORU_R01": (
        "MSH|^~\\&|LIS|LAB|EPIC|MGH|{ts}||ORU^R01|MSG{ts}|P|2.5.1\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M\r"
        "OBR|1|ORD-001||CBC^Complete Blood Count^L|||{ts}|||||||||||||||||F\r"
        "OBX|1|NM|6690-2^WBC^LN||7.5|10*3/uL|4.5-11.0|N|||F\r"
        "OBX|2|NM|789-8^RBC^LN||4.8|10*6/uL|4.5-5.5|N|||F\r"
        "OBX|3|NM|718-7^Hemoglobin^LN||14.2|g/dL|13.5-17.5|N|||F\r"
    ),
    "SIU_S12": (
        "MSH|^~\\&|SCHEDULER|MGH|MIRTH|HUB|{ts}||SIU^S12|MSG{ts}|P|2.5.1\r"
        "SCH|APT-001||||||Routine||||30|MIN|^^30^{ts}^{ts}|||||||||||||Booked\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M\r"
        "RGS|1|A\r"
        "AIS|1|A|99213^Office visit, established patient\r"
        "AIG|1|A|DR100^Lee^Andrew|D\r"
        "AIL|1|A|CLINIC-A^Main Clinic Room 5\r"
    ),
    "MDM_T02": (
        "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||MDM^T02|MSG{ts}|P|2.5.1\r"
        "EVN|T02|{ts}\r"
        "PID|1||PAT-12345^^^MGH^MR||Smith^John^A||19850315|M\r"
        "PV1|1|I|ICU^301^A|||||DR100^Lee^Andrew\r"
        "TXA|1|DS|TX|{ts}|DR100^Lee^Andrew||{ts}|||||DOC-001||||AU\r"
        "OBX|1|TX|||Discharge summary: Patient stable, discharged home with follow-up.\r"
    ),
}


def send_mllp(host: str, port: int, message: str, timeout: int = 30) -> str:
    """Send an HL7v2 message via MLLP framing and return the ACK."""
    mllp_message = MLLP_START + message.encode("utf-8") + MLLP_END

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        sock.sendall(mllp_message)
        response = sock.recv(4096)
        # Strip MLLP framing
        return response.decode("utf-8").strip("\x0b\x1c\x0d")
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description="Send sample HL7v2 messages to Mirth MLLP listener")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=6661)
    parser.add_argument("--message-type", default="ADT_A01", choices=list(SAMPLES.keys()))
    parser.add_argument("--count", type=int, default=1, help="Number of messages to send")
    parser.add_argument("--delay", type=float, default=0, help="Seconds between messages")
    args = parser.parse_args()

    template = SAMPLES[args.message_type]

    success = 0
    failed = 0
    for i in range(args.count):
        ts = datetime.now().strftime("%Y%m%d%H%M%S")
        date = datetime.now().strftime("%Y%m%d")
        message = template.format(ts=ts, date=date)

        try:
            t0 = time.time()
            ack = send_mllp(args.host, args.port, message)
            elapsed = time.time() - t0

            if "AA" in ack:
                success += 1
                print(f"  [{i+1}/{args.count}] ACK: AA ({elapsed:.2f}s) — {args.message_type}")
            elif "AE" in ack or "AR" in ack:
                failed += 1
                print(f"  [{i+1}/{args.count}] NAK ({elapsed:.2f}s) — {ack[:200]}")
            else:
                failed += 1
                print(f"  [{i+1}/{args.count}] UNKNOWN — {ack[:200]}")
        except Exception as e:
            failed += 1
            print(f"  [{i+1}/{args.count}] ERROR: {e}")

        if args.delay > 0 and i < args.count - 1:
            time.sleep(args.delay)

    print(f"\nResults: {success} accepted, {failed} failed (of {args.count})")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
