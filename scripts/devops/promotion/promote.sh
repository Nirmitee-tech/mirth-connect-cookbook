#!/usr/bin/env bash
# Recipe #50 - Promote a Mirth channel from one environment to another
# Tested on Mirth Connect 4.5.2
# Author: Nirmitee.io | License: MIT
#
# Usage:
#   ./promote.sh \
#       --channel hl7v2-adt-router \
#       --from dev \
#       --to staging \
#       --config env-config-template.json \
#       [--tag v2026.05.28-1]   # optional; defaults to timestamped
#
# Rollback (re-import a previously tagged export):
#   ./promote.sh --rollback --channel hl7v2-adt-router --to prod --tag v2026.05.27-3
#
set -euo pipefail

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
CHANNEL=""
FROM_ENV=""
TO_ENV=""
CONFIG="env-config-template.json"
TAG=""
DRY_RUN=0
ROLLBACK=0

usage() {
    cat <<EOF
Usage: $0 --channel NAME --from ENV --to ENV [--config FILE] [--tag TAG] [--dry-run]
       $0 --rollback --channel NAME --to ENV --tag TAG

Required env vars (or set in env-config-template.json):
    MIRTH_{ENV}_URL       e.g. MIRTH_DEV_URL=https://mirth-dev.acme.io:8443
    MIRTH_{ENV}_USER
    MIRTH_{ENV}_PASS
EOF
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --channel)   CHANNEL="$2"; shift 2 ;;
        --from)      FROM_ENV="$2"; shift 2 ;;
        --to)        TO_ENV="$2"; shift 2 ;;
        --config)    CONFIG="$2"; shift 2 ;;
        --tag)       TAG="$2"; shift 2 ;;
        --dry-run)   DRY_RUN=1; shift ;;
        --rollback)  ROLLBACK=1; shift ;;
        -h|--help)   usage ;;
        *)           echo "[fail] unknown arg: $1" >&2; usage ;;
    esac
done

[ -n "$CHANNEL" ] || { echo "[fail] --channel required" >&2; usage; }
[ -n "$TO_ENV" ] || { echo "[fail] --to required" >&2; usage; }
if [ "$ROLLBACK" -eq 0 ]; then
    [ -n "$FROM_ENV" ] || { echo "[fail] --from required (or use --rollback)" >&2; usage; }
fi
[ -f "$CONFIG" ] || { echo "[fail] config file not found: $CONFIG" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +'%H:%M:%S')" "$*"; }
fail() { printf '[fail] %s\n' "$*" >&2; exit 1; }

require_tool() {
    command -v "$1" >/dev/null 2>&1 || fail "required tool missing: $1"
}
require_tool curl
require_tool jq
require_tool git

# Read env URL/creds. Precedence: env var > config file.
env_var() {
    local env="$1"; local field="$2"
    local upper_env upper_field key
    upper_env=$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')
    upper_field=$(printf '%s' "$field" | tr '[:lower:]' '[:upper:]')
    key="MIRTH_${upper_env}_${upper_field}"
    if [ -n "${!key:-}" ]; then
        printf '%s' "${!key}"
        return 0
    fi
    jq -r --arg env "$env" --arg field "$field" '.environments[$env][$field] // empty' "$CONFIG"
}

mirth_get() {
    local env="$1"; local path="$2"
    local url user pass
    url=$(env_var "$env" url) || fail "url not configured for $env"
    user=$(env_var "$env" user) || fail "user not configured for $env"
    pass=$(env_var "$env" pass) || fail "pass not configured for $env"
    curl -sk --fail \
        -u "${user}:${pass}" \
        -H 'X-Requested-With: cookbook-promote' \
        -H 'Accept: application/xml' \
        "${url}${path}"
}

mirth_post() {
    local env="$1"; local path="$2"; local payload_file="$3"
    local url user pass
    url=$(env_var "$env" url)
    user=$(env_var "$env" user)
    pass=$(env_var "$env" pass)
    curl -sk --fail \
        -u "${user}:${pass}" \
        -X POST \
        -H 'X-Requested-With: cookbook-promote' \
        -H 'Content-Type: application/xml' \
        --data-binary @"$payload_file" \
        "${url}${path}"
}

mirth_put() {
    local env="$1"; local path="$2"; local payload_file="$3"
    local url user pass
    url=$(env_var "$env" url)
    user=$(env_var "$env" user)
    pass=$(env_var "$env" pass)
    curl -sk --fail \
        -u "${user}:${pass}" \
        -X PUT \
        -H 'X-Requested-With: cookbook-promote' \
        -H 'Content-Type: application/xml' \
        --data-binary @"$payload_file" \
        "${url}${path}"
}

# Look up channel id by name on a given environment
lookup_channel_id() {
    local env="$1"; local name="$2"
    mirth_get "$env" "/api/channels" \
        | python3 -c "
import sys, xml.etree.ElementTree as ET
root = ET.fromstring(sys.stdin.read())
name = '''$name'''
for ch in root.iter('channel'):
    n = ch.findtext('name') or ''
    if n.strip() == name.strip():
        print((ch.findtext('id') or '').strip())
        sys.exit(0)
sys.exit(1)
" || fail "channel '$name' not found on env '$env'"
}

apply_env_transforms() {
    local infile="$1"; local outfile="$2"; local target_env="$3"
    python3 - "$infile" "$outfile" "$target_env" "$CONFIG" <<'PY'
import json, re, sys
infile, outfile, env, cfg = sys.argv[1:5]
with open(cfg) as f:
    config = json.load(f)
subs = config.get("environments", {}).get(env, {}).get("substitutions", {})
with open(infile) as f:
    xml = f.read()
for k, v in subs.items():
    # Replace ${KEY} and {{KEY}} forms
    xml = xml.replace("${" + k + "}", str(v))
    xml = xml.replace("{{" + k + "}}", str(v))
# Replace any leftover unsubstituted ${X} - fail loudly
leftover = re.findall(r"\$\{[A-Z0-9_]+\}", xml)
if leftover:
    print("[fail] unsubstituted placeholders:", set(leftover), file=sys.stderr)
    sys.exit(2)
with open(outfile, "w") as f:
    f.write(xml)
print(f"[ok] wrote transformed XML to {outfile}")
PY
}

git_tag_export() {
    local channel="$1"; local tag="$2"; local file="$3"
    local archive_dir="exports/${channel}"
    mkdir -p "$archive_dir"
    cp "$file" "${archive_dir}/${tag}.xml"
    git add "${archive_dir}/${tag}.xml" || true
    git -c user.email=promote@nirmitee.io -c user.name="mirth-promote" \
        commit -m "promote(${channel}): tag ${tag}" >/dev/null 2>&1 || true
    git tag -f "promote/${channel}/${tag}" >/dev/null 2>&1 || true
    log "tagged release: promote/${channel}/${tag}"
}

verify_deployment() {
    local env="$1"; local channel_id="$2"
    log "verification: querying channel status on $env"
    local status
    status=$(mirth_get "$env" "/api/channels/${channel_id}/status" 2>/dev/null \
        | grep -oE '<state>[A-Z]+</state>' | head -1 | grep -oE '[A-Z]+' || echo "UNKNOWN")
    if [ "$status" = "STARTED" ]; then
        log "[ok] channel ${channel_id} is STARTED on ${env}"
        return 0
    fi
    fail "channel ${channel_id} on ${env} is in state: ${status}"
}

# ---------------------------------------------------------------------------
# Rollback path
# ---------------------------------------------------------------------------
if [ "$ROLLBACK" -eq 1 ]; then
    [ -n "$TAG" ] || fail "--tag required for rollback"
    archive="exports/${CHANNEL}/${TAG}.xml"
    [ -f "$archive" ] || fail "archived export not found: $archive"
    log "rollback: re-importing $archive into $TO_ENV"
    if [ "$DRY_RUN" -eq 1 ]; then
        log "[dry-run] would PUT $archive to $TO_ENV"
        exit 0
    fi
    channel_id=$(lookup_channel_id "$TO_ENV" "$CHANNEL")
    mirth_put "$TO_ENV" "/api/channels/${channel_id}" "$archive"
    mirth_post "$TO_ENV" "/api/channels/_deploy" "$archive" || true
    verify_deployment "$TO_ENV" "$channel_id"
    log "[ok] rollback complete"
    exit 0
fi

# ---------------------------------------------------------------------------
# Normal promotion path
# ---------------------------------------------------------------------------
if [ -z "$TAG" ]; then
    TAG="v$(date -u +'%Y.%m.%d-%H%M%S')"
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

log "promote: ${CHANNEL} from ${FROM_ENV} -> ${TO_ENV} as tag ${TAG}"

# 1. Look up channel id on source env
log "step 1: looking up channel id on $FROM_ENV"
src_id=$(lookup_channel_id "$FROM_ENV" "$CHANNEL")
log "       channel id: $src_id"

# 2. Export from source
log "step 2: exporting from $FROM_ENV"
src_xml="${workdir}/source.xml"
mirth_get "$FROM_ENV" "/api/channels/${src_id}" > "$src_xml"
log "       saved ${src_xml} ($(wc -l < "$src_xml") lines)"

# 3. Apply env transforms
log "step 3: applying env-specific substitutions for $TO_ENV"
target_xml="${workdir}/target.xml"
apply_env_transforms "$src_xml" "$target_xml" "$TO_ENV"

# 4. Tag in git
log "step 4: committing tagged export"
git_tag_export "$CHANNEL" "$TAG" "$target_xml"

if [ "$DRY_RUN" -eq 1 ]; then
    log "[dry-run] stopping before import. Tagged XML: exports/${CHANNEL}/${TAG}.xml"
    exit 0
fi

# 5. Import into target env (PUT if exists, POST if new)
log "step 5: importing into $TO_ENV"
if dst_id=$(lookup_channel_id "$TO_ENV" "$CHANNEL" 2>/dev/null); then
    log "       channel exists on $TO_ENV (id=$dst_id) - updating via PUT"
    mirth_put "$TO_ENV" "/api/channels/${dst_id}" "$target_xml"
else
    log "       channel does not exist on $TO_ENV - creating via POST"
    mirth_post "$TO_ENV" "/api/channels" "$target_xml"
    dst_id=$(lookup_channel_id "$TO_ENV" "$CHANNEL")
fi

# 6. Deploy
log "step 6: deploying channel ${dst_id} on $TO_ENV"
deploy_payload=$(mktemp)
cat > "$deploy_payload" <<EOF
<set>
  <string>${dst_id}</string>
</set>
EOF
mirth_post "$TO_ENV" "/api/channels/_deploy" "$deploy_payload"
rm -f "$deploy_payload"

# 7. Verify
sleep 5
verify_deployment "$TO_ENV" "$dst_id"

log ""
log "[ok] promotion complete"
log "    channel:  $CHANNEL"
log "    from:     $FROM_ENV"
log "    to:       $TO_ENV"
log "    tag:      $TAG"
log "    archive:  exports/${CHANNEL}/${TAG}.xml"
log ""
log "to rollback:"
log "    $0 --rollback --channel $CHANNEL --to $TO_ENV --tag $TAG"
