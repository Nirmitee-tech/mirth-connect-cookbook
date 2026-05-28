# Recipe #49 — GitHub Actions Channel CI

**Description:** A GitHub Actions workflow that runs on every PR touching a channel, transformer, or code-template XML. Lints the XML, runs JS transformer unit tests, validates FHIR fixtures against US Core 6.1.0, and posts a structural-diff comment back on the PR. Failing checks block merge via branch protection.

**Use case:** Stop "the channel deployed in the GUI works on my laptop" drift. Every channel change is reviewed in PR with mechanical checks first, humans second.

**Requirements:**
- GitHub repository with Actions enabled
- `tests/` directory with the recipe #39 channel unit-test framework (jest + jest-junit)
- (Optional) FHIR fixtures at `sample-data/fhir-fixtures/*.json` for US Core validation

**Tested on:** Mirth Connect `4.5.2`, Python `3.12`, Node `20`, HAPI Validator `6.3.11`, US Core `6.1.0`.
**Author:** Nirmitee.io | **License:** MIT

---

## What runs on each PR

| Job | Tooling | Fails the build when… |
|---|---|---|
| `detect-changes` | `git diff` | (informational; sets the matrix) |
| `lint` | `lint-channel.py` | XML invalid; missing source connector; deprecated XStream class; transformer JS has unbalanced braces; unknown source transport |
| `unit-tests` | `tests/` (jest) | Any transformer unit test fails |
| `fhir-validate` | HAPI Validator CLI | Sample FHIR fixtures don't conform to US Core 6.1.0 |
| `pr-diff-comment` | `test-channel.py` | (never — informational) |
| `ci-required` | aggregate | Any of the above failed |

## Lint rules (from `lint-channel.py`)

| Code | Severity | Catches |
|---|---|---|
| `XML000` | error | XML parse error |
| `MIRTH001` | error | Channel missing `<id>` |
| `MIRTH002` | error | Channel missing `<name>` |
| `MIRTH010` | error | No source connector |
| `MIRTH011` | error | Multiple source connectors |
| `MIRTH012` | error | Source missing `<transportName>` |
| `MIRTH013` | warn | Unknown source transport |
| `MIRTH020` | warn | No destination connectors |
| `MIRTH030` | error | Deprecated XStream class reference |
| `MIRTH040` | error | Transformer JS has unbalanced braces |
| `MIRTH041` | warn | Transformer uses dynamic JS execution |
| `MIRTH050` | warn | `<enabled>` missing |
| `MIRTH060` | warn | Channel exported from unexpected Mirth version |
| `TPL001-003` | error/warn | Code template id/name/contextSet checks |

## Setup

### 1. Enable Actions in your repo

The workflow lives at `.github/workflows/channels-ci.yml` — nothing else needed for it to start running on PRs.

### 2. Branch protection (required for "blocks merge")

Settings → Branches → Add rule:

```
Branch name pattern: main
Require status checks to pass before merging:
    ☑ channels-ci / ci-required
    ☑ channels-ci / lint
    ☑ channels-ci / unit-tests
    ☑ channels-ci / fhir-validate
Require branches to be up to date before merging: ☑
Do not allow bypassing the above settings: ☑
```

Repeat for `channels-stage` and `channels-prod` if you use recipe #50's branching strategy.

### 3. (Optional) PAT for cross-repo comments

The default `GITHUB_TOKEN` works for same-repo PRs. For comments on PRs from forks, create a fine-grained PAT with `pull-requests: write` and store as `BOT_TOKEN` — then swap `secrets.GITHUB_TOKEN` for `secrets.BOT_TOKEN` in the `pr-diff-comment` job.

## Test locally before pushing

```bash
# Lint
python scripts/ci/lint-channel.py --paths channels transformers code-templates

# Diff comment preview
python scripts/ci/test-channel.py --base origin/main --head HEAD --out /tmp/diff.md
cat /tmp/diff.md

# Unit tests
cd tests && npm install && npm test

# FHIR validation (needs Java 17 + HAPI validator)
java -jar validator_cli.jar -version 4.0.1 -ig hl7.fhir.us.core#6.1.0 sample-data/fhir-fixtures/*.json
```

## Customize

- **Different FHIR IG:** Swap `hl7.fhir.us.core#6.1.0` for any package on the FHIR registry (e.g. `hl7.fhir.uv.ips#1.1.0` for International Patient Summary).
- **More aggressive lint:** Pass `--fail-on warn` to `lint-channel.py` to gate on warnings too.
- **PR comment skin:** Edit the markdown template in `test-channel.py` — the script reads + writes plain markdown, no special escaping needed because the workflow reads the file via `fs.readFileSync` (avoids GitHub Actions expression injection).
- **Deploy after merge:** Chain a `deploy.yml` workflow on push to `main` that calls recipe #50's `promote.sh` against your dev environment.

## Security notes

- The workflow uses `permissions:` with read-only contents and write only on `pull-requests`, so a malicious PR can't compromise the repo.
- All untrusted inputs (PR title, branch name, SHAs) are passed via `env:` and read as shell variables — never interpolated directly into `run:` blocks. This blocks the GitHub Actions expression-injection class of vulnerability.
- The PR-diff comment is built in a file by `test-channel.py` and posted via `fs.readFileSync` in `actions/github-script`. The PR author cannot inject markdown that escapes the comment scope.

## File listing

| File | Purpose |
|---|---|
| `.github/workflows/channels-ci.yml` | The workflow |
| `scripts/ci/lint-channel.py` | XML linter (errors + warnings) |
| `scripts/ci/test-channel.py` | PR-comment diff renderer |
