# Recipe #38 — Performance Benchmark Suite

**Description.** An asyncio MLLP load generator that drives configurable
ADT/ORU message rates through a Mirth Connect channel, measures p50/p95/p99
ACK latency, throughput, and error rate, compares results against a saved
baseline, and renders an HTML report with inline SVG charts.

**Use case.** Pre-release regression, capacity planning, and node-sizing for
HL7v2 channels. Run it nightly in CI to catch transformer changes that double
p95 latency, or one-off before customer go-live to validate the sizing of a
new VM.

**Requirements.**
- Python 3.10+
- A Mirth Connect channel with an MLLP listener (e.g. the cookbook's
  `channels/hl7v2-to-fhir-bundle/` channel on port 6661)
- That channel must return a real HL7 ACK (AA / AE / AR) — the harness reads
  `MSA|AA` to count successful messages

**Tested on.** Mirth Connect 4.5.2  
**Author.** Nirmitee.io | **License.** MIT

---

## Layout

```
performance-benchmark/
├── README.md
├── benchmark.py
├── scenarios/
│   ├── 100-mps-adt.json
│   ├── 1000-mps-adt.json
│   └── 10000-mps-oru.json
├── baselines/
│   └── baseline.json
└── sample-output/
    ├── benchmark-results.json
    ├── benchmark-results.csv
    └── benchmark-report.html  (generated)
```

## Where to install

Drop the whole `performance-benchmark/` folder anywhere on a workstation or
CI runner that can open TCP to your Mirth host. Nothing is installed on the
Mirth server itself.

## How to test

```bash
cd scripts/testing/performance-benchmark

# Single scenario
python3 benchmark.py \
  --host 127.0.0.1 --port 6661 \
  --scenarios scenarios/100-mps-adt.json

# Ramp suite, compare against committed baseline
python3 benchmark.py \
  --host mirth.prod.local --port 6661 \
  --scenarios scenarios/100-mps-adt.json scenarios/1000-mps-adt.json scenarios/10000-mps-oru.json \
  --baseline baselines/baseline.json \
  --out-json   results/$(date +%F).json \
  --out-csv    results/$(date +%F).csv \
  --out-html   results/$(date +%F).html

# Rewrite the baseline after a confirmed-good run
python3 benchmark.py \
  --scenarios scenarios/*.json \
  --baseline baselines/baseline.json \
  --save-as-baseline
```

Sample CSV output is committed at `sample-output/benchmark-results.csv` —
your CI pipeline can diff against it.

## Scenario format

```json
{
  "name": "1000mps-adt-ramp",
  "message_type": "ADT_A01",
  "target_rate": 1000,
  "duration_seconds": 60,
  "ramp_up_seconds": 15,
  "concurrency": 200
}
```

- `target_rate` — messages per second the harness aims for (best-effort).
- `ramp_up_seconds` — linear ramp from 1 mps to `target_rate`.
- `concurrency` — max in-flight sockets; raise it if p99 climbs while CPU on
  the load generator is idle and the channel is happy.

## Customize

- **More message types.** Add templates to the `SAMPLES` dict in
  `benchmark.py` (`message_type` must match the key).
- **TLS / MLLPS.** Wrap `asyncio.open_connection` with `ssl=...` —
  pre-built SSLContext, no certificate validation if your sandbox uses
  self-signed.
- **Random payloads.** Replace the templated `n` placeholder with a generator
  that pulls from a corpus on disk; useful to defeat parser caches.
- **Latency percentiles.** Add p999 in `Result.summary()` — the latency list
  is already sorted.

## Interpreting the report

- p95 climbing while CPU stays flat usually means the destination is slow
  (FHIR server, database, MLLP downstream). Check the destination queue.
- Sudden jump in `nacked` is almost always a transformer regression — the
  channel is alive but rejecting messages.
- `errors` (socket level) climbing means the listener or kernel backlog is
  saturated — raise `<maxConnections>` on the MLLP listener or `concurrency`
  on the scenario.
