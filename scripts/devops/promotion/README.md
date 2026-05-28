# Recipe #50 — Multi-Environment Channel Promotion

**Description:** A repeatable promotion workflow that takes a Mirth channel exported from one environment, applies environment-specific configuration substitutions, archives a git-tagged copy, imports into the target environment via the REST API, and verifies deployment. Includes an automatic rollback path that re-imports any previously tagged export.

**Use case:** Teams running Mirth in dev / staging / prod and tired of:
- Hand-editing URLs in channel XML before each import
- Forgetting which version is currently deployed in prod
- Slack-debugging "who pushed that change last Tuesday"
- Re-deploying by clicking around the Mirth Administrator on three different windows

**Requirements:**
- `bash` 4+, `curl`, `jq`, `python3` (no extra packages), `git`
- Mirth REST API user with `Channels:Read/Write` and `Channels:Deploy` permissions in every target environment
- A copy of `env-config-template.json` filled in (and **not** committed if it has secrets)

**Tested on:** Mirth Connect `4.5.2` running on macOS + Ubuntu 22.04.
**Author:** Nirmitee.io | **License:** MIT

---

## Branching strategy

```
channels-dev    ◀── feature branches  (PRs trigger recipe #49 CI)
    │
    │  merge to channels-dev → auto-deploy to dev
    ▼
channels-stage  ◀── manual PR from channels-dev
    │
    │  merge to channels-stage → triggers `promote.sh --to staging`
    ▼
channels-prod   ◀── manual PR from channels-stage (1 approver minimum)
    │
    │  merge to channels-prod → triggers `promote.sh --to prod`
    ▼
git tags: promote/<channel>/<v2026.05.28-1>   ← every promotion is tagged
```

Each branch has its own protection rules (recipe #49). The `exports/<channel>/<tag>.xml` files are committed to whichever branch promoted them — that's the source of truth for "what's running where, and as of when."

## Setup

```bash
# 1. Copy the template and fill it in (DO NOT commit secrets)
cd scripts/devops/promotion
cp env-config-template.json env-config.json
echo "scripts/devops/promotion/env-config.json" >> ../../../.gitignore

# 2. Set credentials via env vars in CI (preferred)
export MIRTH_DEV_PASS='...'
export MIRTH_STAGING_PASS='...'
export MIRTH_PROD_PASS='...'

# 3. Make sure your channels reference substitutions
# In the Mirth GUI, set DB URL to "jdbc:postgresql://${DB_HOST}:5432/${DB_NAME}"
# Or in a code-template constant: var FHIR_URL = "${FHIR_URL}";
```

## Usage

```bash
# Promote dev → staging
./promote.sh \
    --channel hl7v2-adt-router \
    --from dev \
    --to staging \
    --config env-config.json

# Promote staging → prod (with explicit tag)
./promote.sh \
    --channel hl7v2-adt-router \
    --from staging \
    --to prod \
    --config env-config.json \
    --tag v2026.05.28-go-live

# Dry-run (export, transform, tag — but skip the import + deploy)
./promote.sh --channel my-channel --from dev --to prod --dry-run

# Rollback prod to a known-good tag
./promote.sh \
    --rollback \
    --channel hl7v2-adt-router \
    --to prod \
    --tag v2026.05.27-3
```

## What the script does

1. **Lookup** — finds the channel id on the source env by name (`/api/channels`).
2. **Export** — GETs the full channel XML.
3. **Transform** — walks `env-config.json` and replaces every `${KEY}` and `{{KEY}}` in the XML with the target environment's value. Fails loudly if any placeholder is left unsubstituted.
4. **Tag** — writes `exports/<channel>/<tag>.xml`, commits it with `mirth-promote` as author, and tags it `promote/<channel>/<tag>`.
5. **Import** — uses the target env's API; PUTs if the channel exists there, POSTs otherwise.
6. **Deploy** — calls `/api/channels/_deploy` with the channel id.
7. **Verify** — polls `/api/channels/{id}/status` and expects `STARTED` within 5 seconds.

If any step fails the script exits non-zero with a `[fail]` line — the calling CI job marks the promotion as failed.

## CI integration

```yaml
# .github/workflows/promote.yml
name: promote
on:
  push:
    branches: [channels-stage, channels-prod]
jobs:
  promote:
    runs-on: ubuntu-22.04
    environment:
      name: ${{ github.ref == 'refs/heads/channels-prod' && 'prod' || 'staging' }}
    steps:
      - uses: actions/checkout@v4
      - name: Detect changed channels
        id: changes
        env:
          BEFORE: ${{ github.event.before }}
          AFTER:  ${{ github.sha }}
        run: |
          set -euo pipefail
          changed=$(git diff --name-only "$BEFORE" "$AFTER" \
              | grep -E '^channels/.*\.xml$' \
              | xargs -I{} basename {} .xml \
              | sort -u)
          echo "channels<<EOF" >> "$GITHUB_OUTPUT"
          echo "$changed" >> "$GITHUB_OUTPUT"
          echo "EOF" >> "$GITHUB_OUTPUT"
      - name: Promote each changed channel
        env:
          MIRTH_STAGING_PASS: ${{ secrets.MIRTH_STAGING_PASS }}
          MIRTH_PROD_PASS:    ${{ secrets.MIRTH_PROD_PASS }}
          TARGET: ${{ github.ref == 'refs/heads/channels-prod' && 'prod' || 'staging' }}
          SOURCE: ${{ github.ref == 'refs/heads/channels-prod' && 'staging' || 'dev' }}
          CHANNELS: ${{ steps.changes.outputs.channels }}
        run: |
          set -euo pipefail
          for ch in $CHANNELS; do
            scripts/devops/promotion/promote.sh \
                --channel "$ch" \
                --from "$SOURCE" \
                --to "$TARGET" \
                --config scripts/devops/promotion/env-config.json
          done
```

GitHub Environments give you the "approval before deploy" gate for free — make `prod` a protected environment with required reviewers.

## Substitution conventions

Inside the Mirth GUI, write your channel as if it were a template:

| Where | Placeholder | Replaced with |
|---|---|---|
| Destination DB URL | `jdbc:postgresql://${DB_HOST}:5432/${DB_NAME}` | `pg-stg.../mirthapp_stg` |
| HTTP Sender URL | `${FHIR_URL}/Patient` | `https://fhir-stg.../fhir/Patient` |
| Code template constant | `var KAFKA_BROKERS = "${KAFKA_BROKERS}";` | `kafka-stg-1:9092,...` |
| Alert email | `${ALERT_EMAIL}` | `stg-oncall@acme.io` |

Both `${KEY}` (shell-style) and `{{KEY}}` (mustache-style) work. Pick one convention per team.

## Customize

- **Different secrets backend:** Replace the `mirth_get` / `mirth_post` curl auth with mTLS, or fetch creds from Vault before the script runs.
- **Multi-channel atomic deploy:** Wrap multiple channel ids into one `<set>` payload to `/api/channels/_deploy` so they go live together.
- **Approval workflow:** Add `--require-approval-from <user>` and check a JSON file of approvers before importing.
- **Compare-before-promote:** Run `xmldiff` between the transformed XML and what's already deployed on the target. Abort if no diff (no-op) or print the diff and prompt.
- **Slack notification:** `curl` a Slack webhook after step 7 with the channel + tag + env.

## Rollback notes

The rollback path re-uses the tagged XML in `exports/<channel>/<tag>.xml`. That XML was already environment-substituted at promote time, so rollback to prod uses prod values — no re-substitution. This is intentional: a rollback should restore *exactly* what was running, byte-for-byte.

If you need to roll back further than what's archived, `git checkout` an older tag and re-run `promote.sh` from that ref.

## Security notes

- Passwords are read from environment variables in CI, never from the config file. The `pass` field in `env-config.json` is allowed to be empty.
- The script runs `set -euo pipefail` so any failed curl or missing tool aborts immediately.
- Substitution placeholders are matched as `${UPPERCASE_AND_UNDERSCORES}` only, so unrelated `${var}` shell-isms in transformer JS are left alone.
- The `lookup_channel_id` step uses python's `xml.etree.ElementTree` to safely parse — no shell injection from channel names possible.

## File listing

| File | Purpose |
|---|---|
| `promote.sh` | The promotion script |
| `env-config-template.json` | Per-env URLs + substitution maps |
| `exports/<channel>/<tag>.xml` | (Generated) tagged channel exports — committed |
