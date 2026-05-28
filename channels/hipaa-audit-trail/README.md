# Recipe #32 — HIPAA Audit Trail Channel

> A side-car Mirth channel that turns every PHI access into a FHIR-shaped, tamper-evident row in an append-only Postgres table. Wire any other channel to publish into this one and you get audit logging that satisfies HIPAA § 164.312(b) without changing the source channels' business logic.

## What this recipe gives you

- `sql/audit_event_table.sql` — Postgres schema for the audit log:
  - `audit.audit_event` table with FHIR `AuditEvent`-aligned fields
  - lookup of valid actions (C/R/U/D/E)
  - append-only enforcement via `REVOKE UPDATE,DELETE` + BEFORE triggers
  - `audit.verify_chain()` function that re-computes the hash chain and returns broken rows
- `transformer.js` — source transformer that
  - reads an event envelope JSON from another channel,
  - computes `sha256(payload || prev_hash)` for tamper evidence,
  - caches the last hash in `globalChannelMap` so the chain doesn't require a DB read per event,
  - populates `channelMap` keys for the Database Writer destination
- A documented Channel configuration (Channel Reader source + Database Writer destination)

## Why

HIPAA Audit Controls (45 CFR § 164.312(b)) require a covered entity to *"implement hardware, software, and/or procedural mechanisms that record and examine activity in information systems that contain or use electronic protected health information."* Concretely, a HIPAA auditor looking at a Mirth deployment will ask:

1. Show me every time MRN12345's record was read.
2. Show me everything user `alice@hospital` did yesterday.
3. Prove the log hasn't been altered.

The schema in this recipe answers all three:

- (1) `WHERE patient_id = 'MRN12345'`
- (2) `WHERE user_id = 'alice@hospital' AND occurred_at >= '2026-05-27'`
- (3) `SELECT * FROM audit.verify_chain()` returns empty if the hash chain is intact

## Where the pieces live

```
channels/hipaa-audit-trail/
├── README.md                       <-- this file
├── transformer.js                  <-- source transformer
└── sql/
    └── audit_event_table.sql       <-- schema, triggers, verify function
```

## 1. Provision the database

```bash
# Use the same Postgres as Mirth itself (or a dedicated audit DB)
docker exec -i mirth-db psql -U mirthdb -d mirthdb \
    < channels/hipaa-audit-trail/sql/audit_event_table.sql
```

Verify:
```bash
docker exec mirth-db psql -U mirthdb -d mirthdb -c "\d audit.audit_event"
docker exec mirth-db psql -U mirthdb -d mirthdb -c "SELECT * FROM audit.action_code;"
```

## 2. Create the channel

In Mirth Connect Administrator:

### Channel-level settings
- Name: `AuditTrail`
- Data Types: **Source = Raw**, Destination = Raw
- Message Storage: **Production (raw + processed + maps)** — you actually want this stored
- Enable Attachments: NO
- Encrypt message content: YES (keystore lives elsewhere; audit log JSON is PHI)

### Source — Channel Reader
- Type: **Channel Reader**
- This makes the channel only invokable via `router.routeMessageByChannelName('AuditTrail', envelopeJson)`

### Source transformer
Paste `transformer.js`. It will populate `channelMap` keys used by the destination.

### Destination — Database Writer
- Type: **Database Writer**
- Driver: PostgreSQL
- URL: `jdbc:postgresql://mirth-db:5432/mirthdb`
- Username/Password: from configurationMap `audit.db.user` / `audit.db.password`
- Use Javascript: **NO** (use SQL parameter binding for safety)
- SQL:

```sql
INSERT INTO audit.audit_event (
    event_uuid, occurred_at, channel_id, channel_name, message_id, server_id,
    source_ip, user_id, user_role, action, outcome, outcome_desc,
    patient_id, resource_type, resource_id, detail_json, prev_hash, row_hash
) VALUES (
    ${event_uuid}::uuid, ${occurred_at}::timestamptz, ${channel_id}, ${channel_name},
    ${message_id}, ${server_id}, NULLIF(${source_ip},'')::inet, ${user_id}, ${user_role},
    ${action}, ${outcome}, ${outcome_desc}, ${patient_id}, ${resource_type},
    ${resource_id}, NULLIF(${detail_json},'')::jsonb, ${prev_hash}, ${row_hash}
)
```

## 3. Publish events from your source channels

In any channel that touches PHI, add a Destination step or a post-processor that fires:

```javascript
var auditEnvelope = {
    occurredAt:   new Date().toISOString(),
    channelId:    channelId,
    channelName:  channelName,
    messageId:    connectorMessage.getMessageId(),
    action:       'R',                        // C/R/U/D/E
    outcome:      '0',
    userId:       channelMap.get('authenticated_user') || 'system',
    userRole:     channelMap.get('user_role')        || 'system',
    patientId:    $('PID')['PID.3']['PID.3.1'].toString(),
    resourceType: 'HL7v2:' + $('MSH')['MSH.9']['MSH.9.1'].toString()
                + '^' + $('MSH')['MSH.9']['MSH.9.2'].toString(),
    resourceId:   connectorMessage.getMessageId(),
    sourceIp:     channelMap.get('source_ip')
};
router.routeMessageByChannelName('AuditTrail', JSON.stringify(auditEnvelope));
```

For FHIR resources:
```javascript
router.routeMessageByChannelName('AuditTrail', JSON.stringify({
    occurredAt:   new Date().toISOString(),
    channelId:    channelId, channelName: channelName,
    messageId:    connectorMessage.getMessageId(),
    action:       'C',
    userId:       channelMap.get('oauth_sub'),
    userRole:     'Practitioner',
    patientId:    fhirResource.subject && fhirResource.subject.reference,
    resourceType: fhirResource.resourceType,
    resourceId:   fhirResource.resourceType + '/' + fhirResource.id
}));
```

## 4. Tamper-evidence proof (verified)

```bash
node -e "
const crypto = require('crypto');
const sha = s => crypto.createHash('sha256').update(s,'utf8').digest('hex');
const ZERO = '0'.repeat(64);
let prev = ZERO;
const e1 = 'evt1' + '2026-05-28T00:00:00Z' + 'ch1' + 'm1' + 'alice' + 'R' + 'P1' + 'Patient' + 'Patient/P1' + '' + prev;
const h1 = sha(e1); prev = h1;
const e2 = 'evt2' + '2026-05-28T00:00:01Z' + 'ch1' + 'm2' + 'bob' + 'C' + 'P2' + 'Patient' + 'Patient/P2' + '' + prev;
const h2 = sha(e2);
console.log('row1 hash:', h1.slice(0,16));
console.log('row2 hash:', h2.slice(0,16));
// Flip a single field on row1 -> hash changes -> row2's prev_hash mismatch is detectable
"
```

Schedule the verifier nightly:

```bash
docker exec mirth-db psql -U mirthdb -d mirthdb -c \
    "SELECT * FROM audit.verify_chain();" \
    | tee /var/log/mirth/audit-verify.log

# Expect zero rows. Any row in the output means tamper or replication-induced reorder.
```

## 5. Retention & rotation

- **Keep audit logs for 6 years** (HIPAA-recommended floor for individual rights records). Some states require longer (Texas: 7y; New York minors: until 21 + 6).
- Partition `audit.audit_event` by month (`PARTITION BY RANGE(occurred_at)`) when the table exceeds ~100M rows.
- Archive old partitions to cold storage (S3 with Object Lock) — see Recipe #35 for the backup script.
- **Never** TRUNCATE this table. Use `DETACH PARTITION + DROP TABLE` after the archive has been validated.

## 6. Configuration map keys

| Key | Example | Purpose |
|---|---|---|
| `audit.db.url`      | `jdbc:postgresql://mirth-db:5432/mirthdb` | JDBC URL for hash-chain bootstrap query |
| `audit.db.user`     | `mirthdb`                                  | DB user |
| `audit.db.password` | `<vault>`                                  | DB password — consider Recipe #33 |
| `server.id`         | `mirth-prod-01`                            | Stamped into every audit row |

## Tested on

- Mirth Connect 4.5.2
- PostgreSQL 16 (docker-compose alpine image)
- Verified hash math under Node.js 22.x

## Author / License

Author: Nirmitee.io
License: MIT
