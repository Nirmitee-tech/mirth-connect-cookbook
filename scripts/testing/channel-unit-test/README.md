# Recipe #39 — Channel Unit Test Framework

**Description.** A Mocha-style JavaScript unit-test harness for Mirth Connect
transformers. Executes tests on host using Mozilla Rhino — the **same**
JavaScript engine Mirth runs at runtime — so the behaviour you see in CI
matches the behaviour you get in the IDE. Outputs JUnit XML for any
standard CI pipeline.

**Use case.** Catch transformer regressions in pull requests, run a green-
field test suite before every channel deployment, and document expected
output shape via fixtures instead of "we tested it manually".

**Requirements.**
- Python 3.10+
- Mozilla Rhino 1.7.13+ (`brew install rhino` on macOS — needs a recent JDK
  to match Rhino's class file version; OpenJDK 17+ works)
- The transformer-under-test must run in plain Rhino (no Mirth-only
  built-ins like `SourceMap` or `Packages.com.mirth.connect...`). If the
  transformer references Mirth-only classes, wrap them in try/catch.

**Tested on.** Mirth Connect 4.5.2  
**Author.** Nirmitee.io | **License.** MIT

---

## Layout

```
channel-unit-test/
├── README.md
├── test-runner.py            # main entry point
├── sample-test.js            # template for new tests
├── fixtures/
│   ├── test-harness.js       # describe/it/expect + msg/channelMap shims
│   ├── adt-a01-sepsis.hl7
│   ├── adt-a01-sepsis.expected.json
│   ├── oru-cbc.hl7
│   └── oru-cbc.expected.json
└── tests/
    ├── adt-to-fhir.test.js
    ├── adt-to-fhir.test.meta.json
    ├── oru-to-fhir.test.js
    └── oru-to-fhir.test.meta.json
```

## Where to install

Anywhere with Python + Java + Rhino. Typical placement: alongside your
channels repo so CI can run it as `python3 test-runner.py` from the project
root. Nothing is installed on the Mirth server.

## How to test

```bash
cd scripts/testing/channel-unit-test

# macOS — point at the brew-installed rhino jar + recent JDK
RHINO_JAR=/opt/homebrew/Cellar/rhino/1.9.1/libexec/rhino.jar \
PATH=/opt/homebrew/opt/openjdk/bin:$PATH \
python3 test-runner.py

# Linux CI
python3 test-runner.py --rhino-jar /usr/share/java/rhino.jar

# Pin which tests to run
python3 test-runner.py --tests tests/ --junit ./test-results.xml
```

Sample output against the cookbook's two committed transformers:

```
  [PASS] ADT -> FHIR Bundle transformer :: runs against the A01 sepsis fixture (45.8 ms)
  [PASS] ADT -> FHIR Bundle transformer :: emits a valid transaction Bundle (0.8 ms)
  [PASS] ADT -> FHIR Bundle transformer :: includes Patient, Encounter, Organization, Practitioner (2.1 ms)
  [PASS] ADT -> FHIR Bundle transformer :: links Patient.id to the PID-3 MRN (0.5 ms)
  [PASS] ADT -> FHIR Bundle transformer :: creates a Condition with the ICD-10 sepsis code A41.9 (0.9 ms)
  [PASS] ADT -> FHIR Bundle transformer :: fires the SEP-1 + ICU + geriatric flags for an elderly inpatient sepsis admit (0.2 ms)
  [PASS] ADT -> FHIR Bundle transformer :: emits exactly 1 STAT/URGENT alert for sepsis (0.2 ms)
  [PASS] ADT -> FHIR Bundle transformer :: stores businessRules JSON with facility + ward mappings (0.5 ms)
  [PASS] ORU -> FHIR DiagnosticReport transformer :: runs against the CBC fixture without throwing (31.1 ms)
  [PASS] ORU -> FHIR DiagnosticReport transformer :: emits a FHIR transaction Bundle (1.0 ms)
  ...
Total: 14  Passed: 14  Failed: 0
JUnit: test-results.xml
```

## Authoring a new test

1. Drop an HL7 fixture into `fixtures/` (literal `\r` line endings are fine
   — the harness normalises).
2. Drop an `<name>.expected.json` next to it with whatever scalars you
   want to assert (see `oru-cbc.expected.json`).
3. Copy `sample-test.js` to `tests/<name>.test.js`.
4. Create `tests/<name>.test.meta.json` pointing at the transformer + the
   fixture pair:
   ```json
   {
     "transformer": "transformers/<recipe>/transformer.js",
     "fixture_hl7": "<name>.hl7",
     "expected":    "<name>.expected.json"
   }
   ```
5. `python3 test-runner.py` — it auto-discovers everything matching
   `tests/*.test.js`.

## What the harness gives you

| Symbol | Notes |
|---|---|
| `msg` | Parsed HL7v2 fixture. Supports `msg['PID']['PID.3']['PID.3.1'].toString()` — Mirth's natural access pattern. |
| `channelMap` | `put / get / containsKey / __dump()`. |
| `globalChannelMap` | Aliased to `channelMap` (no separate global scope in unit tests). |
| `logger` | All methods silent — keeps test output clean. |
| `__runTransformer()` | Loads + executes the transformer source under the harness scope. Call once per test, or once per file. |
| `describe / it` | Mocha-style. Tests are reported with their suite name in JUnit `classname`. |
| `expect(...)` | Matchers: `toBe / toEqual / toBeTruthy / toContain / toHaveProperty / toHaveLength`. |

## Known limitations

- **No E4X.** Mirth's HL7 parser exposes a `Packages.com.mirth.connect...` XML
  node that supports E4X-style `msg.PID[0].'PID.3'['PID.3.1']` access. Our
  shim provides flat keys (`msg['PID']['PID.3']['PID.3.1']`) instead — which
  covers ~95% of real-world transformers but not the dynamic `.descendants()`
  style. Two patterns that break: paths containing escaped dots resolved via
  `path.split('.')` (the cookbook's ORU transformer uses this — see
  `tests/oru-to-fhir.test.js` for how we work around it), and `for each` /
  `.@attr` E4X syntax. For those, run a smoke test against a live Mirth
  instance instead.
- **No Apache HttpClient / Mirth packages.** If your transformer calls
  `Packages.org.apache.http.impl.client.HttpClients`, wrap the call in
  `try/catch` and assert against the cached result in `channelMap` — see
  the ADT transformer's `txTestResult` pattern.
- **Multiple OBX repeated segments.** Currently the parser groups repeats
  into a JS array of segment objects. The test harness exposes them as
  `msg['OBX']` array; the cookbook's ORU transformer's `safeGet()` does
  not handle this in Rhino-only mode (see ORU test file's NOTE).

## CI integration

```yaml
# .github/workflows/channel-tests.yml
- name: Channel unit tests
  run: |
    sudo apt-get install -y rhino
    python3 scripts/testing/channel-unit-test/test-runner.py \
      --junit test-results.xml
- uses: dorny/test-reporter@v1
  with:
    name: Mirth channel tests
    path: test-results.xml
    reporter: java-junit
```

## Customize

- Add new matchers by extending the `expect()` object in
  `fixtures/test-harness.js`.
- For non-HL7 fixtures (FHIR JSON, X12, Redox), bypass `__parseHL7` and
  inject your own `msg` global at the top of the test file.
- For destination-connector tests, populate `channelMap` manually before
  calling `__runTransformer()` to simulate prior steps.
