#!/usr/bin/env bash
#
# Recipe #30 — MLLPS with TLS Mutual Authentication
# verify-mtls.sh — Probe an MLLPS listener with openssl s_client and confirm mTLS handshake
#
# Usage:
#   ./verify-mtls.sh --host HOST --port PORT --certs DIR [--cafile FILE] [--key FILE] [--cert FILE]
#
# Examples:
#   ./verify-mtls.sh --host localhost --port 6661 --certs ./certs
#   ./verify-mtls.sh --host mllps.prod.example --port 2575 \
#     --cafile /etc/ssl/ca.crt --cert /etc/ssl/client.crt --key /etc/ssl/client.key
#
# Exit codes:
#   0  — handshake succeeded with client auth verified
#   1  — handshake failed (server not asking for client cert OR cert rejected)
#   2  — bad input / missing files
#
# Tested on: OpenSSL 3.x against Mirth Connect 4.5.2 MLLPS Listener
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

HOST=""
PORT=""
CERTS=""
CAFILE=""
CERT=""
KEY=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --host)   HOST="$2"; shift 2 ;;
        --port)   PORT="$2"; shift 2 ;;
        --certs)  CERTS="$2"; shift 2 ;;
        --cafile) CAFILE="$2"; shift 2 ;;
        --cert)   CERT="$2"; shift 2 ;;
        --key)    KEY="$2"; shift 2 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 2 ;;
    esac
done

[[ -z "$HOST" || -z "$PORT" ]] && { echo "--host and --port are required" >&2; exit 2; }

if [[ -n "$CERTS" ]]; then
    CAFILE="${CAFILE:-$CERTS/ca.crt}"
    CERT="${CERT:-$CERTS/client.crt}"
    KEY="${KEY:-$CERTS/client.key}"
fi

for f in "$CAFILE" "$CERT" "$KEY"; do
    [[ -f "$f" ]] || { echo "Missing file: $f" >&2; exit 2; }
done

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

echo ">> Probing MLLPS endpoint $HOST:$PORT with client cert $CERT"

# -showcerts: print server chain; -verify 5: enforce depth; -tls1_2 minimum
# We feed an empty stdin and 5s timeout so s_client exits cleanly.
set +e
echo "" | openssl s_client \
    -connect "$HOST:$PORT" \
    -CAfile "$CAFILE" \
    -cert   "$CERT" \
    -key    "$KEY" \
    -verify 5 \
    -tls1_2 \
    -showcerts \
    -servername "$HOST" \
    2>&1 | tee "$TMP" >/dev/null
RC=$?
set -e

# Analyze output
if grep -q "Verify return code: 0 (ok)" "$TMP"; then
    VERIFY_OK=1
else
    VERIFY_OK=0
fi

if grep -q "Acceptable client certificate CA names" "$TMP"; then
    SERVER_ASKED_FOR_CLIENT_CERT=1
else
    SERVER_ASKED_FOR_CLIENT_CERT=0
fi

CIPHER=$(grep -E "^\s*Cipher\s*:" "$TMP" | head -1 | awk -F: '{print $2}' | xargs || true)
PROTO=$(grep -E "^\s*Protocol\s*:" "$TMP" | head -1 | awk -F: '{print $2}' | xargs || true)

echo
echo "================================ Handshake Summary ================================"
printf "  Protocol               : %s\n" "${PROTO:-?}"
printf "  Cipher                 : %s\n" "${CIPHER:-?}"
printf "  Server requested mTLS  : %s\n" "$([[ $SERVER_ASKED_FOR_CLIENT_CERT == 1 ]] && echo YES || echo NO)"
printf "  Server cert verified   : %s\n" "$([[ $VERIFY_OK == 1 ]] && echo YES || echo NO)"
echo "==================================================================================="

if [[ $SERVER_ASKED_FOR_CLIENT_CERT == 0 ]]; then
    echo "FAIL: Server did NOT request a client certificate." >&2
    echo "      Enable 'Client Authentication = Required' on the MLLPS Source Connector." >&2
    exit 1
fi

if [[ $VERIFY_OK == 0 ]]; then
    echo "FAIL: Server certificate chain did not verify against $CAFILE." >&2
    exit 1
fi

echo "OK: mTLS handshake succeeded."
exit 0
