#!/usr/bin/env python3
"""
benchmark.py - Asyncio-driven MLLP load generator for Mirth Connect channels.

Drives a target rate of HL7v2 messages (ADT / ORU) through an MLLP listener,
measures end-to-end ACK latency (p50/p95/p99), throughput, and error rate,
compares against a saved baseline (JSON), and emits an HTML report with
inline SVG charts.

Tested on: Mirth Connect 4.5.2 (MLLP listener on port 6661)
Author: Nirmitee.io | License: MIT
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

MLLP_START = b"\x0b"
MLLP_END = b"\x1c\x0d"

SAMPLE_ADT = (
    "MSH|^~\\&|EPIC|MGH|MIRTH|HUB|{ts}||ADT^A01|{ctrl}|P|2.5.1\r"
    "EVN|A01|{ts}\r"
    "PID|1||PAT-{n:08d}^^^MGH^MR||Smith^John^A||19850315|M|||"
    "123 Main St^^Boston^MA^02108^US||617-555-1234|||S\r"
    "PV1|1|I|ICU^301^A|E|||DR100^Lee^Andrew|||MED||||7|||"
    "DR100^Lee^Andrew|IP|V{n:08d}|||||||||||||||||||||||||{ts}\r"
    "DG1|1||A41.9^Sepsis, unspecified organism^ICD10|||A\r"
)

SAMPLE_ORU = (
    "MSH|^~\\&|LIS|LAB|MIRTH|HUB|{ts}||ORU^R01|{ctrl}|P|2.5.1\r"
    "PID|1||PAT-{n:08d}^^^MGH^MR||Smith^John||19850315|M\r"
    "OBR|1|ORD-{n}||CBC^Complete Blood Count^L|||{ts}|||||||||||||||||||F\r"
    "OBX|1|NM|6690-2^WBC^LN||7.5|10*3/uL|4.5-11.0|N|||F\r"
    "OBX|2|NM|718-7^Hemoglobin^LN||14.2|g/dL|13.5-17.5|N|||F\r"
    "OBX|3|NM|4544-3^Hematocrit^LN||42.0|%|41.0-53.0|N|||F\r"
)

SAMPLES = {"ADT_A01": SAMPLE_ADT, "ORU_R01": SAMPLE_ORU}


@dataclass
class Scenario:
    name: str
    message_type: str
    target_rate: int          # messages per second
    duration_seconds: int     # total runtime
    ramp_up_seconds: int = 0  # linear ramp from 0 -> target_rate
    concurrency: int = 50     # max concurrent in-flight sockets

    @classmethod
    def from_file(cls, path: Path) -> "Scenario":
        data = json.loads(path.read_text())
        return cls(**data)


@dataclass
class Result:
    scenario: str
    message_type: str
    target_rate: int
    duration_seconds: int
    sent: int = 0
    acked: int = 0
    nacked: int = 0
    errors: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""

    def summary(self) -> dict:
        lat = sorted(self.latencies_ms)

        def pct(p: float) -> float:
            if not lat:
                return 0.0
            k = max(0, min(len(lat) - 1, int(round((p / 100.0) * (len(lat) - 1)))))
            return round(lat[k], 2)

        elapsed = max(1, self.duration_seconds)
        return {
            "scenario": self.scenario,
            "message_type": self.message_type,
            "target_rate_mps": self.target_rate,
            "duration_seconds": self.duration_seconds,
            "sent": self.sent,
            "acked": self.acked,
            "nacked": self.nacked,
            "errors": self.errors,
            "error_rate_pct": round(
                100.0 * (self.nacked + self.errors) / max(1, self.sent), 3
            ),
            "throughput_mps": round(self.acked / elapsed, 2),
            "latency_ms": {
                "min": round(min(lat), 2) if lat else 0.0,
                "p50": pct(50),
                "p95": pct(95),
                "p99": pct(99),
                "max": round(max(lat), 2) if lat else 0.0,
                "mean": round(statistics.fmean(lat), 2) if lat else 0.0,
            },
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


def build_message(message_type: str, n: int) -> bytes:
    template = SAMPLES[message_type]
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    body = template.format(n=n, ctrl=f"BENCH{n}", ts=ts)
    return MLLP_START + body.encode("utf-8") + MLLP_END


async def send_one(
    host: str,
    port: int,
    payload: bytes,
    result: Result,
    timeout: float,
) -> None:
    t0 = time.perf_counter()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=timeout
        )
        writer.write(payload)
        await writer.drain()
        ack = await asyncio.wait_for(reader.readuntil(b"\x1c\x0d"), timeout=timeout)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        result.latencies_ms.append(elapsed_ms)
        # Look for MSA|AA (accept) / MSA|AE (error) / MSA|AR (reject)
        if b"MSA|AA" in ack:
            result.acked += 1
        elif b"MSA|AE" in ack or b"MSA|AR" in ack:
            result.nacked += 1
        else:
            result.acked += 1  # ambiguous; count as ack
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
    except Exception:
        result.errors += 1


async def run_scenario(
    scenario: Scenario, host: str, port: int, timeout: float
) -> Result:
    result = Result(
        scenario=scenario.name,
        message_type=scenario.message_type,
        target_rate=scenario.target_rate,
        duration_seconds=scenario.duration_seconds,
        started_at=datetime.now(timezone.utc).isoformat(),
    )
    sem = asyncio.Semaphore(scenario.concurrency)
    tasks: list[asyncio.Task] = []
    n = 0
    start = time.perf_counter()
    end_at = start + scenario.duration_seconds

    async def fire(idx: int) -> None:
        async with sem:
            payload = build_message(scenario.message_type, idx)
            await send_one(host, port, payload, result, timeout)

    while True:
        now = time.perf_counter()
        if now >= end_at:
            break
        elapsed = now - start
        if scenario.ramp_up_seconds > 0 and elapsed < scenario.ramp_up_seconds:
            rate = max(
                1.0, scenario.target_rate * (elapsed / scenario.ramp_up_seconds)
            )
        else:
            rate = float(scenario.target_rate)
        interval = 1.0 / rate
        n += 1
        result.sent += 1
        tasks.append(asyncio.create_task(fire(n)))
        await asyncio.sleep(interval)

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    result.finished_at = datetime.now(timezone.utc).isoformat()
    return result


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def render_svg_bars(title: str, series: dict[str, float], color: str = "#4f46e5") -> str:
    if not series:
        return ""
    max_v = max(series.values()) or 1.0
    bar_w = 60
    gap = 20
    chart_h = 220
    width = (bar_w + gap) * len(series) + gap
    height = chart_h + 60
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}">',
        f'<text x="10" y="20" font-family="system-ui" font-size="14" font-weight="600">{title}</text>',
    ]
    for i, (label, val) in enumerate(series.items()):
        x = gap + i * (bar_w + gap)
        h = (val / max_v) * (chart_h - 30)
        y = chart_h - h + 20
        parts.append(
            f'<rect x="{x}" y="{y}" width="{bar_w}" height="{h}" fill="{color}" rx="4"/>'
        )
        parts.append(
            f'<text x="{x + bar_w/2}" y="{y - 5}" font-size="11" '
            f'text-anchor="middle" fill="#111">{val:.1f}</text>'
        )
        parts.append(
            f'<text x="{x + bar_w/2}" y="{chart_h + 40}" font-size="11" '
            f'text-anchor="middle" fill="#444">{label}</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def render_html(
    summaries: list[dict], baseline: Optional[dict], output_path: Path
) -> None:
    rows = []
    for s in summaries:
        base = (baseline or {}).get(s["scenario"], {}) if baseline else {}
        base_p95 = base.get("latency_ms", {}).get("p95")
        delta = ""
        if base_p95:
            d = s["latency_ms"]["p95"] - base_p95
            color = "#dc2626" if d > 0 else "#16a34a"
            delta = (
                f'<span style="color:{color}">'
                f'{"+" if d>=0 else ""}{d:.1f} ms vs baseline {base_p95} ms'
                f'</span>'
            )
        rows.append(
            f"<tr>"
            f"<td>{s['scenario']}</td>"
            f"<td>{s['message_type']}</td>"
            f"<td>{s['target_rate_mps']}</td>"
            f"<td>{s['throughput_mps']}</td>"
            f"<td>{s['latency_ms']['p50']}</td>"
            f"<td>{s['latency_ms']['p95']} {delta}</td>"
            f"<td>{s['latency_ms']['p99']}</td>"
            f"<td>{s['error_rate_pct']}%</td>"
            f"</tr>"
        )

    p95_series = {s["scenario"]: s["latency_ms"]["p95"] for s in summaries}
    tput_series = {s["scenario"]: s["throughput_mps"] for s in summaries}
    chart_p95 = render_svg_bars("p95 latency (ms)", p95_series, "#4f46e5")
    chart_tput = render_svg_bars("Throughput (msg/sec)", tput_series, "#16a34a")

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Mirth Benchmark Report</title>
<style>
 body {{ font-family: system-ui, sans-serif; margin: 24px; color: #111; }}
 h1 {{ font-size: 22px; }}
 table {{ border-collapse: collapse; width: 100%; margin-top: 18px; }}
 th, td {{ border: 1px solid #ddd; padding: 8px 10px; font-size: 13px; text-align: left; }}
 th {{ background: #f3f4f6; }}
 .charts {{ display: flex; gap: 30px; flex-wrap: wrap; margin-top: 20px; }}
</style></head><body>
<h1>Mirth Connect Performance Benchmark</h1>
<p>Generated: {datetime.now(timezone.utc).isoformat()}</p>
<div class="charts">{chart_p95}{chart_tput}</div>
<table>
 <thead><tr>
  <th>Scenario</th><th>Type</th><th>Target rate</th><th>Throughput</th>
  <th>p50 ms</th><th>p95 ms</th><th>p99 ms</th><th>Error %</th>
 </tr></thead>
 <tbody>{''.join(rows)}</tbody>
</table>
</body></html>
"""
    output_path.write_text(html)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=6661)
    p.add_argument(
        "--scenarios",
        type=Path,
        nargs="+",
        required=True,
        help="One or more scenario JSON files",
    )
    p.add_argument(
        "--baseline",
        type=Path,
        default=None,
        help="Existing JSON to compare against",
    )
    p.add_argument(
        "--out-json",
        type=Path,
        default=Path("benchmark-results.json"),
    )
    p.add_argument(
        "--out-html",
        type=Path,
        default=Path("benchmark-report.html"),
    )
    p.add_argument("--out-csv", type=Path, default=Path("benchmark-results.csv"))
    p.add_argument("--timeout", type=float, default=5.0)
    p.add_argument(
        "--save-as-baseline",
        action="store_true",
        help="Write results to --baseline path as new baseline",
    )
    args = p.parse_args()

    baseline = None
    if args.baseline and args.baseline.exists():
        baseline = json.loads(args.baseline.read_text())

    summaries: list[dict] = []
    for sp in args.scenarios:
        scenario = Scenario.from_file(sp)
        print(
            f"[run] {scenario.name}  {scenario.message_type}  "
            f"target={scenario.target_rate} mps  duration={scenario.duration_seconds}s",
            file=sys.stderr,
        )
        result = asyncio.run(
            run_scenario(scenario, args.host, args.port, args.timeout)
        )
        summary = result.summary()
        summaries.append(summary)
        print(json.dumps(summary, indent=2), file=sys.stderr)

    args.out_json.write_text(json.dumps(summaries, indent=2))

    # CSV
    csv_lines = [
        "scenario,message_type,target_rate_mps,throughput_mps,p50_ms,p95_ms,p99_ms,error_rate_pct,sent,acked,nacked,errors"
    ]
    for s in summaries:
        csv_lines.append(
            f"{s['scenario']},{s['message_type']},{s['target_rate_mps']},"
            f"{s['throughput_mps']},{s['latency_ms']['p50']},{s['latency_ms']['p95']},"
            f"{s['latency_ms']['p99']},{s['error_rate_pct']},{s['sent']},"
            f"{s['acked']},{s['nacked']},{s['errors']}"
        )
    args.out_csv.write_text("\n".join(csv_lines) + "\n")

    render_html(summaries, baseline, args.out_html)

    if args.save_as_baseline and args.baseline:
        keyed = {s["scenario"]: s for s in summaries}
        args.baseline.write_text(json.dumps(keyed, indent=2))
        print(f"[baseline] saved -> {args.baseline}", file=sys.stderr)

    print(f"[done] JSON={args.out_json}  CSV={args.out_csv}  HTML={args.out_html}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
