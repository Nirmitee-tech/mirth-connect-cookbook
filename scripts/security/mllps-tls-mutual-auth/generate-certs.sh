#!/usr/bin/env bash
#
# Recipe #30 — MLLPS with TLS Mutual Authentication
# generate-certs.sh — Generate a local CA + server cert + client cert for development
#
# Usage:
#   ./generate-certs.sh [--out DIR] [--cn-server HOST] [--cn-client NAME] [--days N] [--dry-run]
#
# Produces (under $OUT, default ./certs):
#   ca.key                  — CA private key (KEEP OFFLINE in real life)
#   ca.crt                  — CA certificate
#   server.key / server.crt — MLLPS listener identity (signed by CA)
#   server-keystore.p12     — PKCS#12 keystore for Mirth (alias=server)
#   client.key / client.crt — MLLPS sender identity (signed by CA)
#   client-keystore.p12     — PKCS#12 keystore for Mirth Destination
#   truststore.p12          — PKCS#12 truststore containing only ca.crt
#
# Passwords default to "changeit" and can be overridden via $KEY_PASS / $STORE_PASS.
# WARNING: Self-signed CA is for dev only. In production use your enterprise PKI
#          or a managed CA (Vault PKI, AWS Private CA, smallstep, etc.).
#
# Tested on: Mirth Connect 4.5.2, OpenSSL 3.x, keytool (OpenJDK 17)
# Author: Nirmitee.io
# License: MIT

set -euo pipefail

OUT="./certs"
CN_SERVER="mirth-mllps.local"
CN_CLIENT="mirth-client"
DAYS=825
DRY_RUN=0
KEY_PASS="${KEY_PASS:-changeit}"
STORE_PASS="${STORE_PASS:-changeit}"

usage() {
    sed -n '2,18p' "$0"
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out)        OUT="$2"; shift 2 ;;
        --cn-server)  CN_SERVER="$2"; shift 2 ;;
        --cn-client)  CN_CLIENT="$2"; shift 2 ;;
        --days)       DAYS="$2"; shift 2 ;;
        --dry-run)    DRY_RUN=1; shift ;;
        -h|--help)    usage ;;
        *) echo "Unknown arg: $1" >&2; usage ;;
    esac
done

run() {
    if [[ "$DRY_RUN" == "1" ]]; then
        printf '  [dry-run] %s\n' "$*"
    else
        eval "$@"
    fi
}

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }
command -v keytool >/dev/null || { echo "keytool not found (install OpenJDK)" >&2; exit 1; }

echo ">> Output dir: $OUT"
run "mkdir -p '$OUT'"
cd "$OUT" 2>/dev/null || true
[[ "$DRY_RUN" == "1" ]] || cd "$OUT"

# ---------- 1. Root CA ----------
echo ">> Generating Root CA (ca.key, ca.crt)"
run "openssl genrsa -out ca.key 4096"
run "openssl req -x509 -new -nodes -key ca.key -sha256 -days $((DAYS * 4)) \
     -subj '/C=US/ST=CA/O=Nirmitee Dev CA/CN=Nirmitee Mirth Dev Root CA' \
     -out ca.crt"

# ---------- 2. Server cert (MLLPS listener) ----------
echo ">> Generating server cert for CN=$CN_SERVER"
run "openssl genrsa -out server.key 2048"
cat > server.cnf <<EOF
[req]
distinguished_name = dn
req_extensions     = v3_req
prompt             = no
[dn]
C=US
ST=CA
O=Nirmitee Dev
CN=$CN_SERVER
[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
DNS.1 = $CN_SERVER
DNS.2 = localhost
IP.1  = 127.0.0.1
EOF
run "openssl req -new -key server.key -out server.csr -config server.cnf"
run "openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
     -out server.crt -days $DAYS -sha256 -extensions v3_req -extfile server.cnf"

# ---------- 3. Client cert (MLLPS sender) ----------
echo ">> Generating client cert for CN=$CN_CLIENT"
run "openssl genrsa -out client.key 2048"
cat > client.cnf <<EOF
[req]
distinguished_name = dn
req_extensions     = v3_req
prompt             = no
[dn]
C=US
ST=CA
O=Nirmitee Dev
CN=$CN_CLIENT
[v3_req]
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
EOF
run "openssl req -new -key client.key -out client.csr -config client.cnf"
run "openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
     -out client.crt -days $DAYS -sha256 -extensions v3_req -extfile client.cnf"

# ---------- 4. PKCS#12 bundles ----------
echo ">> Packaging PKCS#12 keystores (password from \$STORE_PASS)"
run "openssl pkcs12 -export -in server.crt -inkey server.key -name server \
     -CAfile ca.crt -caname mirth-dev-ca -chain \
     -out server-keystore.p12 -passout pass:$STORE_PASS"
run "openssl pkcs12 -export -in client.crt -inkey client.key -name client \
     -CAfile ca.crt -caname mirth-dev-ca -chain \
     -out client-keystore.p12 -passout pass:$STORE_PASS"

# ---------- 5. Truststore (CA only) ----------
echo ">> Building truststore.p12 containing CA"
run "rm -f truststore.p12"
run "keytool -importcert -noprompt -trustcacerts -alias mirth-dev-ca \
     -file ca.crt -keystore truststore.p12 -storetype PKCS12 \
     -storepass $STORE_PASS"

# ---------- 6. Verify ----------
if [[ "$DRY_RUN" != "1" ]]; then
    echo
    echo ">> Verifying chain"
    openssl verify -CAfile ca.crt server.crt
    openssl verify -CAfile ca.crt client.crt
    echo
    echo ">> Files in $OUT:"
    ls -la
fi

echo
echo "Done. Next steps:"
echo "  1. Copy server-keystore.p12 + truststore.p12 to the Mirth host"
echo "  2. Configure the Source TCP Listener (MLLPS) — see README.md"
echo "  3. Copy client-keystore.p12 + truststore.p12 to the Mirth client"
echo "  4. Run ./verify-mtls.sh to confirm the handshake"
