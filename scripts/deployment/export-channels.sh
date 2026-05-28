#!/usr/bin/env bash
# export-channels.sh — Export all Mirth channels to XML files for version control
#
# Usage:
#   ./export-channels.sh [--out exports/] [--server https://localhost:8443] [--user admin] [--pass admin]

set -euo pipefail

OUT="exports"
SERVER="https://localhost:8443"
USER="admin"
PASS="admin"

while [[ $# -gt 0 ]]; do
    case $1 in
        --out) OUT="$2"; shift 2 ;;
        --server) SERVER="$2"; shift 2 ;;
        --user) USER="$2"; shift 2 ;;
        --pass) PASS="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

mkdir -p "$OUT"
COOKIE=$(mktemp)
trap "rm -f $COOKIE" EXIT

curl -sk -X POST -H "X-Requested-With: OpenAPI" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -c "$COOKIE" \
    -d "username=$USER&password=$PASS" \
    "$SERVER/api/users/_login" > /dev/null

# Get all channel IDs and names
export SERVER OUT COOKIE
curl -sk -H "X-Requested-With: OpenAPI" -H "Accept: application/json" -b "$COOKIE" \
    "$SERVER/api/channels/idsAndNames" | python3 -c "
import json, sys, os, subprocess

data = json.load(sys.stdin)
entries = data.get('map', {}).get('entry', [])
if not isinstance(entries, list):
    entries = [entries]

server = os.environ['SERVER']
out = os.environ['OUT']
cookie = os.environ['COOKIE']

count = 0
for e in entries:
    strings = e.get('string', [])
    if not isinstance(strings, list) or len(strings) != 2:
        continue
    channel_id, name = strings
    safe_name = ''.join(c if c.isalnum() else '-' for c in name).strip('-').lower()
    filename = f'{out}/{safe_name}-{channel_id[:8]}.xml'

    # Export channel XML
    result = subprocess.run([
        'curl', '-sk',
        '-H', 'X-Requested-With: OpenAPI',
        '-H', 'Accept: application/xml',
        '-b', cookie,
        f'{server}/api/channels/{channel_id}'
    ], capture_output=True, text=True)

    if result.returncode == 0 and result.stdout:
        with open(filename, 'w') as f:
            f.write(result.stdout)
        print(f'  ✓ {name} → {filename}')
        count += 1
    else:
        print(f'  ✗ Failed: {name}')

print(f'\nExported {count} channels to {out}/')
"
