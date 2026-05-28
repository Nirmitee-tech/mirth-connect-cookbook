#!/usr/bin/env python3
"""
test-runner.py - Mocha-style unit-test harness for Mirth Connect transformers.

Executes JavaScript tests using Mozilla Rhino (Mirth's actual JS engine), so
the behaviour you see in the IDE matches the behaviour you get on CI.

Each test file uses describe()/it()/expect() helpers loaded from
fixtures/test-harness.js. Tests load:
  - A fixture HL7v2 message (parsed via Mirth's HL7v2 reader compat shim)
  - The transformer-under-test as plain text
  - A mock 'msg', 'channelMap', 'logger', 'globalChannelMap' context

Outputs:
  - Human-readable pass/fail to stdout
  - JUnit XML to --junit (for CI integration)
  - Exit code 0 / 1

Tested on: Mirth Connect 4.5.2 (Rhino-compatible ES5 transformers)
Author: Nirmitee.io | License: MIT
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class TestResult:
    suite: str
    name: str
    passed: bool
    duration_ms: float
    error: Optional[str] = None


def find_rhino_jar() -> Optional[str]:
    candidates = [
        os.environ.get("RHINO_JAR"),
        "/usr/local/share/rhino/rhino.jar",
        "/opt/homebrew/share/rhino/rhino.jar",
        "/usr/share/java/rhino.jar",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    if shutil.which("rhino"):
        return "WRAPPER"
    return None


HARNESS_JS_PATH = Path(__file__).parent / "fixtures" / "test-harness.js"


def build_runner_script(
    harness_js: str,
    transformer_path: str,
    fixture_hl7: str,
    test_js: str,
    expected_json: str,
    out_json: str,
) -> str:
    # Variables injected BEFORE the harness because the harness references
    # __FIXTURE_HL7 / __TRANSFORMER_PATH at parse time.
    return f"""
var __FIXTURE_HL7      = {json.dumps(fixture_hl7)};
var __EXPECTED         = {expected_json};
var __OUT_PATH         = {json.dumps(out_json)};
var __TRANSFORMER_PATH = {json.dumps(transformer_path)};

{harness_js}

{test_js}

__harness.flush(__OUT_PATH);
"""


def discover_tests(test_dir: Path) -> list[Path]:
    return sorted(test_dir.glob("*.test.js"))


def run_single_test(
    rhino_runner: list[str],
    test_file: Path,
    transformer_src: str,
    fixture_hl7: str,
    expected_json: str,
    harness_js: str,
) -> list[TestResult]:
    test_js = test_file.read_text()
    with tempfile.TemporaryDirectory() as td:
        runner = Path(td) / "runner.js"
        out_json = Path(td) / "results.json"
        transformer_path = Path(td) / "transformer.js"
        transformer_path.write_text(transformer_src)
        runner.write_text(
            build_runner_script(
                harness_js,
                str(transformer_path),
                fixture_hl7,
                test_js,
                expected_json,
                str(out_json),
            )
        )
        cmd = rhino_runner + [str(runner)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            return [
                TestResult(
                    suite=test_file.stem,
                    name="<rhino-crash>",
                    passed=False,
                    duration_ms=0.0,
                    error=(proc.stderr or proc.stdout)[:4000],
                )
            ]
        if not out_json.exists():
            return [
                TestResult(
                    suite=test_file.stem,
                    name="<no-output>",
                    passed=False,
                    duration_ms=0.0,
                    error="harness produced no results file",
                )
            ]
        data = json.loads(out_json.read_text() or "[]")
        return [
            TestResult(
                suite=d["suite"],
                name=d["name"],
                passed=d["passed"],
                duration_ms=d["duration_ms"],
                error=d.get("error"),
            )
            for d in data
        ]


def write_junit(results: list[TestResult], path: Path) -> None:
    testsuite = ET.Element(
        "testsuite",
        {
            "name": "mirth-channel-unit-tests",
            "tests": str(len(results)),
            "failures": str(sum(1 for r in results if not r.passed)),
            "time": f"{sum(r.duration_ms for r in results) / 1000.0:.3f}",
        },
    )
    for r in results:
        tc = ET.SubElement(
            testsuite,
            "testcase",
            {
                "classname": r.suite,
                "name": r.name,
                "time": f"{r.duration_ms / 1000.0:.4f}",
            },
        )
        if not r.passed:
            fail = ET.SubElement(tc, "failure", {"message": (r.error or "")[:200]})
            fail.text = r.error or ""
    ET.ElementTree(testsuite).write(path, encoding="utf-8", xml_declaration=True)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tests", type=Path, default=Path("tests"))
    p.add_argument("--fixtures", type=Path, default=Path("fixtures"))
    p.add_argument("--junit", type=Path, default=Path("test-results.xml"))
    p.add_argument("--rhino-jar", default=None)
    args = p.parse_args()

    rhino_jar = args.rhino_jar or find_rhino_jar()
    if not rhino_jar:
        print(
            "ERROR: rhino not found. Install with 'brew install rhino' "
            "or set RHINO_JAR=/path/to/rhino.jar",
            file=sys.stderr,
        )
        return 2

    rhino_runner = ["rhino"] if rhino_jar == "WRAPPER" else ["java", "-jar", rhino_jar]

    harness_js = HARNESS_JS_PATH.read_text()
    test_files = discover_tests(args.tests)
    if not test_files:
        print(f"no *.test.js found in {args.tests}", file=sys.stderr)
        return 1

    all_results: list[TestResult] = []
    for tf in test_files:
        meta_path = tf.with_suffix(".meta.json")
        if not meta_path.exists():
            all_results.append(
                TestResult(
                    suite=tf.stem,
                    name="<missing-meta>",
                    passed=False,
                    duration_ms=0.0,
                    error=f"expected {meta_path.name} alongside test file",
                )
            )
            continue
        meta = json.loads(meta_path.read_text())
        repo_root = Path(__file__).resolve().parents[3]
        transformer_path = repo_root / meta["transformer"]
        transformer_src = transformer_path.read_text()
        fixture_hl7 = (args.fixtures / meta["fixture_hl7"]).read_text()
        expected_json = (args.fixtures / meta["expected"]).read_text()
        results = run_single_test(
            rhino_runner, tf, transformer_src, fixture_hl7, expected_json, harness_js
        )
        all_results.extend(results)

    passed = sum(1 for r in all_results if r.passed)
    failed = len(all_results) - passed
    for r in all_results:
        mark = "PASS" if r.passed else "FAIL"
        print(f"  [{mark}] {r.suite} :: {r.name} ({r.duration_ms:.1f} ms)")
        if not r.passed and r.error:
            print(f"         -> {r.error}")
    print()
    print(f"Total: {len(all_results)}  Passed: {passed}  Failed: {failed}")

    write_junit(all_results, args.junit)
    print(f"JUnit: {args.junit}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
