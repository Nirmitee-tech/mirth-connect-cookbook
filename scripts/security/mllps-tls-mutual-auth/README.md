# Recipe #30 — MLLPS with TLS Mutual Authentication

> Encrypt and authenticate every MLLP hop. Both ends present X.509 certs issued by a trusted CA; either side rejects the connection if the peer cert is missing, expired, or revoked.

## What this recipe gives you

- `generate-certs.sh` — a one-shot script that produces a dev CA, server keystore, client keystore, and a shared truststore (PKCS#12) using `openssl` + `keytool`
- A documented Mirth **Source TCP Listener (MLLPS)** configuration that enforces client certificate authentication
- A documented Mirth **Destination TCP Sender (MLLPS)** configuration that presents a client cert and validates the server
- `verify-mtls.sh` — `openssl s_client` probe that prints the handshake summary and exits non-zero if mTLS isn't being enforced
- A safe certificate rotation procedure

## Why mTLS for MLLP

Plain MLLP runs in cleartext on TCP. HIPAA's transmission security rule (§ 164.312(e)) requires that ePHI in motion be protected from unauthorized access. MLLPS = MLLP wrapped in TLS, and mutual TLS additionally answers the *"who is allowed to send me HL7?"* question without bolting on a token or password.

| Threat | Plain MLLP | MLLPS (server-only TLS) | MLLPS + mTLS |
|---|---|---|---|
| Wire sniffing | YES vulnerable | mitigated | mitigated |
| Server impersonation | YES | mitigated | mitigated |
| Arbitrary client posting HL7 | YES | YES | mitigated |
| Compromised CA can MITM | n/a | YES | YES (limit blast radius with cert pinning + private CA) |

## Where the pieces live

```
scripts/security/mllps-tls-mutual-auth/
├── README.md              <-- this file
├── generate-certs.sh      <-- dev CA + certs + PKCS#12 bundles
├── verify-mtls.sh         <-- handshake probe
└── certs/                 <-- created by generate-certs.sh (gitignored)
    ├── ca.crt / ca.key
    ├── server.crt / server.key / server-keystore.p12
    ├── client.crt / client.key / client-keystore.p12
    └── truststore.p12
```

## 1. Generate dev certs

```bash
cd scripts/security/mllps-tls-mutual-auth
chmod +x generate-certs.sh verify-mtls.sh

# Default settings: CN=mirth-mllps.local, 825-day leaf certs, 9-year CA
./generate-certs.sh --out ./certs

# Or customise
./generate-certs.sh --out ./certs \
    --cn-server hl7-ingest.hospital.example \
    --cn-client epic-mllp-sender \
    --days 365

# Dry-run to see commands without writing
./generate-certs.sh --dry-run
```

Passwords default to `changeit`. Override before running:
```bash
KEY_PASS='S3cur3-Key' STORE_PASS='S3cur3-Store' ./generate-certs.sh
```

> **Production warning** — the script's self-signed root CA is for dev only. In production, issue server/client certs from your enterprise PKI, HashiCorp Vault PKI engine, AWS Private CA, or smallstep. Treat `ca.key` like the family jewels — keep it offline.

## 2. Configure the Mirth Source TCP Listener (MLLPS)

Open Mirth Connect Administrator -> Channel -> **Source -> TCP Listener** and set:

| Field | Value |
|---|---|
| Listener Type | **TCP Listener** |
| Source Transport Mode | **MLLP** (sample frame), or MLLP V2 if you need ACK semantics |
| Listener Address | `0.0.0.0` |
| Listener Port | `6661` (or your standard MLLPS port; commonly 2575) |
| Receive Timeout | `30000` |
| Use Local Binding | unchecked |

Switch to the **SSL** sub-panel:

| Field | Value |
|---|---|
| Mode | **SSL** |
| Protocols | `TLSv1.2,TLSv1.3` (uncheck older) |
| Cipher Suites | leave default unless your security baseline restricts further |
| Client Authentication | **Required**  <-- this is what enforces mTLS |
| Key Store File | `/opt/connect/certs/server-keystore.p12` |
| Key Store Type | `PKCS12` |
| Key Store Password | from `$STORE_PASS` |
| Key Password | from `$KEY_PASS` |
| Trust Store File | `/opt/connect/certs/truststore.p12` |
| Trust Store Type | `PKCS12` |
| Trust Store Password | from `$STORE_PASS` |

Mount the certs into the container (matches `docker/docker-compose.yml`):

```yaml
volumes:
  - ./scripts/security/mllps-tls-mutual-auth/certs:/opt/connect/certs:ro
```

Restart the channel — the listener will now reject any TCP connection without a CA-signed client cert.

## 3. Configure the Mirth Destination TCP Sender (MLLPS)

For Mirth-to-Mirth MLLPS or any outbound MLLPS, on the **Destination -> TCP Sender**:

| Field | Value |
|---|---|
| Transport Mode | MLLP (frame matching the peer) |
| Destination Address | `hl7-ingest.hospital.example` |
| Destination Port | `6661` |
| Mode | **SSL** |
| Protocols | `TLSv1.2,TLSv1.3` |
| Key Store File | `/opt/connect/certs/client-keystore.p12` |
| Trust Store File | `/opt/connect/certs/truststore.p12` |
| Verify host name | **enabled** (must match CN/SAN of server cert) |
| Send Timeout | `10000` |
| Response Timeout | `10000` |

If the peer offers MSH-driven routing, also enable **Process HL7 ACK** so failed acks become Mirth errors.

## 4. Verify the handshake

After the channel is deployed and `STARTED`:

```bash
./verify-mtls.sh --host localhost --port 6661 --certs ./certs
```

Expected output:
```
================================ Handshake Summary ================================
  Protocol               : TLSv1.3
  Cipher                 : TLS_AES_256_GCM_SHA384
  Server requested mTLS  : YES
  Server cert verified   : YES
===================================================================================
OK: mTLS handshake succeeded.
```

The script exits non-zero if the server *did not* request a client cert — useful as a CI gate before promoting a channel.

You can also send a real ADT after `\x0b` framing:
```bash
( printf '\x0bMSH|^~\\&|TEST|TEST|MIRTH|MIRTH|20260528120000||ADT^A04|MSGID01|P|2.5.1\rEVN|A04|20260528120000\rPID|1||MRN12345||DOE^JANE\r\x1c\r' ) | \
  openssl s_client -quiet -connect localhost:6661 \
    -CAfile ./certs/ca.crt -cert ./certs/client.crt -key ./certs/client.key
```

## 5. Certificate rotation procedure

Leaf certs in this script default to 825 days (Apple/Mozilla max for browser TLS, a useful sanity ceiling). Rotate at 60 days remaining.

```bash
# 1. Issue new leaf cert(s) — re-run generate-certs.sh for ONE side or both
./generate-certs.sh --out ./certs-new --cn-server $SAME_CN --cn-client $SAME_CN

# 2. Stage new keystore alongside the existing one
docker cp ./certs-new/server-keystore.p12 mirth-connect:/opt/connect/certs/server-keystore.new.p12

# 3. Update the Source Connector keystore path -> apply (DOES NOT drop in-flight)
#    Mirth re-opens the listening socket; existing in-flight TCP connections continue
#    on the OLD socket until they close. New connections use the NEW cert.

# 4. After both sides have switched, remove the old keystore
docker exec mirth-connect rm /opt/connect/certs/server-keystore.p12
docker exec mirth-connect mv /opt/connect/certs/server-keystore.new.p12/opt/connect/certs/server-keystore.p12
```

Rules of thumb:
- **Never** rotate the CA and the leaf certs at the same time. Stage in two phases.
- Keep the old CA in the truststore for one full rotation window (clients with cached chains).
- Track expiry with the watchdog (Recipe #36) — alert at T-60d, T-30d, T-7d.

```bash
# Quick check: days remaining on a cert
openssl x509 -in certs/server.crt -noout -enddate
```

## 6. Customize

- **Pinned cert (no CA)** — drop the leaf cert into `truststore.p12` instead of `ca.crt` and set Client Authentication to "Required". Stronger but harder to rotate.
- **Per-tenant client certs** — issue one client cert per HIS / per facility, set Subject DN to the facility ID, and route in the source transformer using `channelMap.put('facility', connectorMessage.getMetaDataMap().get('SOURCE_CERT_SUBJECT'))`.
- **OCSP / CRL revocation** — add `-Dcom.sun.security.enableCRLDP=true` to `VMOPTIONS` and serve a CRL URL from your CA.

## Tested on

- Mirth Connect 4.5.2 (Docker `nextgenhealthcare/connect:4.5.2`)
- OpenSSL 3.x (LibreSSL 3.x also works for `s_client`)
- keytool from OpenJDK 17.0.13

## Author / License

Author: Nirmitee.io
License: MIT
