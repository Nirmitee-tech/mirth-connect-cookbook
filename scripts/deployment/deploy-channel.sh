#!/usr/bin/env bash
# deploy-channel.sh — Idempotent Mirth Connect channel deployment via REST API
#
# Usage:
#   ./deploy-channel.sh --file path/to/channel.xml [--server https://localhost:8443] [--user admin] [--pass admin]
#
# What it does:
#   1. Authenticates to Mirth REST API
#   2. POSTs the channel XML (creates or updates by UUID)
#   3. Enables the channel in metadata (required before deploy)
#   4. Triggers deploy
#   5. Verifies the channel is in STARTED state
#
# Tested on: Mirth Connect 4.5.2

set -euo pipefail

SERVER="https://localhost:8443"
USER="admin"
PASS="admin"
FILE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --file) FILE="$2"; shift 2 ;;
        --server) SERVER="$2"; shift 2 ;;
        --user) USER="$2"; shift 2 ;;
        --pass) PASS="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [[ -z "$FILE" ]]; then
    echo "Usage: $0 --file path/to/channel.xml [--server URL] [--user USER] [--pass PASS]"
    exit 1
fi

if [[ ! -f "$FILE" ]]; then
    echo "File not found: $FILE"
    exit 1
fi

COOKIE=$(mktemp)
trap "rm -f $COOKIE" EXIT

echo "==> Authenticating to $SERVER..."
curl -sk -X POST \
    -H "X-Requested-With: OpenAPI" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -c "$COOKIE" \
    -d "username=$USER&password=$PASS" \
    "$SERVER/api/users/_login" > /dev/null

# Extract channel ID from XML
CHANNEL_ID=$(grep -m1 '<id>' "$FILE" | sed 's/.*<id>\(.*\)<\/id>.*/\1/' | tr -d ' ')
CHANNEL_NAME=$(grep -m1 '<name>' "$FILE" | sed 's/.*<name>\(.*\)<\/name>.*/\1/')

echo "==> Channel: $CHANNEL_NAME"
echo "==> ID: $CHANNEL_ID"

# Check if channel exists (decide POST vs PUT)
EXISTS=$(curl -sk -H "X-Requested-With: OpenAPI" -H "Accept: application/json" -b "$COOKIE" \
    "$SERVER/api/channels/idsAndNames" 2>/dev/null | grep -c "$CHANNEL_ID" || true)

if [[ "$EXISTS" -gt 0 ]]; then
    echo "==> Channel exists. Undeploying first..."
    curl -sk -X POST -H "X-Requested-With: OpenAPI" -b "$COOKIE" \
        "$SERVER/api/channels/$CHANNEL_ID/_undeploy" > /dev/null
    sleep 2
    echo "==> Deleting existing channel..."
    curl -sk -X DELETE -H "X-Requested-With: OpenAPI" -b "$COOKIE" \
        "$SERVER/api/channels/$CHANNEL_ID" > /dev/null
fi

echo "==> Importing channel XML..."
RESULT=$(curl -sk -X POST \
    -H "X-Requested-With: OpenAPI" \
    -H "Content-Type: application/xml" \
    -b "$COOKIE" \
    --data-binary "@$FILE" \
    "$SERVER/api/channels")

if [[ "$RESULT" != '{"boolean":true}' ]]; then
    echo "ERROR: Channel import failed: $RESULT"
    exit 1
fi
echo "    Imported."

echo "==> Verifying channel is valid (not stub)..."
INVALID=$(curl -sk -H "X-Requested-With: OpenAPI" -H "Accept: application/xml" -b "$COOKIE" \
    "$SERVER/api/channels/$CHANNEL_ID" | grep -c "This channel is invalid" || true)
if [[ "$INVALID" -gt 0 ]]; then
    echo "ERROR: Channel was imported but marked as invalid. Check extensions and XML format."
    exit 1
fi
echo "    Valid."

echo "==> Enabling channel in metadata..."
curl -sk -X PUT \
    -H "X-Requested-With: OpenAPI" \
    -H "Content-Type: application/xml" \
    -b "$COOKIE" \
    -d "<map><entry><string>$CHANNEL_ID</string><com.mirth.connect.model.ChannelMetadata><enabled>true</enabled></com.mirth.connect.model.ChannelMetadata></entry></map>" \
    "$SERVER/api/server/channelMetadata" > /dev/null
echo "    Enabled."

echo "==> Deploying channel..."
curl -sk -X POST -H "X-Requested-With: OpenAPI" -b "$COOKIE" \
    "$SERVER/api/channels/$CHANNEL_ID/_deploy?returnErrors=true" > /dev/null
sleep 3
echo "    Deploy triggered."

echo "==> Verifying channel is STARTED..."
STATE=$(curl -sk -H "X-Requested-With: OpenAPI" -H "Accept: application/json" -b "$COOKIE" \
    "$SERVER/api/channels/statuses" | python3 -c "
import sys, json
data = json.load(sys.stdin)
entries = data.get('list', {}).get('dashboardStatus', [])
if isinstance(entries, dict): entries = [entries]
for e in entries:
    if e.get('channelId') == '$CHANNEL_ID':
        print(e.get('state', 'UNKNOWN'))
        break
" 2>/dev/null)

if [[ "$STATE" == "STARTED" ]]; then
    echo "    ✓ Channel STARTED."
    echo ""
    echo "Success! Channel '$CHANNEL_NAME' is live."
else
    echo "    ✗ Channel not started (state: $STATE)."
    echo "Check Mirth logs for errors:"
    echo "  docker exec mirth-connect tail -50 /opt/connect/logs/mirth.log"
    exit 1
fi
