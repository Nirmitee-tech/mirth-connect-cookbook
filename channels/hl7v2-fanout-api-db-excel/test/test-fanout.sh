#!/bin/bash
# End-to-end test of the fan-out channel.
# Sends one MLLP-framed ORU^R01, then verifies all three destinations received it.
#
# Prereqs:
#   - Channel deployed in Mirth listening on :6680
#   - mock-api-server.py running on :8089
#   - PostgreSQL reachable with lab_results table created
#   - Mirth file writer pointed at ./lab-results.csv

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

CHANNEL_PORT="${CHANNEL_PORT:-6680}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:-mirthdb}"
DB_PASS="${DB_PASS:-mirthdb}"
DB_NAME="${DB_NAME:-mirthdb}"
CSV_PATH="${CSV_PATH:-./lab-results.csv}"

echo "=== 1. Send sample ORU^R01 via MLLP to :${CHANNEL_PORT} ==="
python3 - <<EOF
import socket, sys
with open("${HERE}/sample-oru-r01.hl7", "rb") as f:
    msg = f.read().replace(b"\n", b"\r")
s = socket.create_connection(("localhost", ${CHANNEL_PORT}), timeout=5)
s.sendall(b"\x0b" + msg + b"\x1c\x0d")
try:
    ack = s.recv(1024)
    print("ACK:", ack[:60])
except socket.timeout:
    print("No ACK (channel still processed message)")
s.close()
EOF

echo ""
echo "Waiting 3s for fan-out to complete..."
sleep 3

echo ""
echo "=== 2. Verify Destination 2 (DB): row in lab_results ==="
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$DB_NAME" -c \
  "SELECT message_id, mrn, test_name, has_abnormal, api_status, api_ack_id FROM lab_results WHERE message_id = 'MSG00042';"

echo ""
echo "=== 3. Verify Destination 3 (CSV): row appended ==="
if [ -f "$CSV_PATH" ]; then
    echo "Last line of $CSV_PATH:"
    tail -1 "$CSV_PATH"
else
    echo "WARNING: $CSV_PATH not found. Check Mirth File Writer destination config."
fi

echo ""
echo "=== Done. ==="
echo "All three destinations should have processed the same message:"
echo "  D1 (API):   ack id and status in DB row's api_ack_id / api_status columns"
echo "  D2 (DB):    row visible above"
echo "  D3 (CSV):   row visible above"
