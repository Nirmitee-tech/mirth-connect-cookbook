# Recipe #35 — Backup & Restore Automation

> Encrypted, S3-uploaded, checksum-verified full backups of a Mirth Connect deployment, and a tested restore procedure that will get you back up in under an hour.

## What this recipe gives you

- `backup.sh` — captures `mirthdb` + channels XML + code templates + alerts + configurationMap + keystores + `custom-lib`, GPG-encrypts the bundle, uploads to S3 with a SHA-256 sidecar
- `restore.sh` — downloads, verifies, decrypts, restores Postgres, re-imports channels & code templates & alerts & config map via REST; keystore restore is opt-in for safety
- RPO / RTO guidance and a tested rollback procedure

## Why bother

| Failure mode | DR answer |
|---|---|
| Bad channel deploy corrupts behavior | re-import previous `channels.xml` (5 minutes) |
| Postgres data loss / corruption | `pg_restore -c` from latest dump (15 min for a 5 GB DB) |
| Host loss | re-provision + run `restore.sh --apply-keystores` (45 minutes) |
| Region loss | restore from cross-region replicated S3 (RTO ≈ 1 hour) |

The bundle is **PHI on disk** (the message tables contain ePHI). Encryption at rest is mandatory — backup.sh refuses to run without `--gpg-recipient` or `--gpg-pass-file`.

## RPO / RTO targets

| Schedule | RPO | RTO |
|---|---|---|
| Hourly `backup.sh` with incremental WAL archive separately | 5-15 min | 1 hr |
| Daily `backup.sh` (default) | 24 hr | 1 hr |
| Weekly only | 7 days | 1 hr |

For a true 5-minute RPO, layer pgBackRest or WAL-G **in addition to** this snapshot script — they handle continuous WAL streaming. This recipe is the wide-net "everything you need to rebuild" snapshot.

## Where the files live

```
scripts/operations/backup-restore/
├── README.md
├── backup.sh
└── restore.sh
```

## Prepare encryption

Two modes:

### Public-key mode (preferred)

```bash
# On a separate trusted host, generate a recovery key
gpg --batch --quick-generate-key recovery@mirth.example default default 5y

# Export the public key only and import it on the backup host
gpg --armor --export recovery@mirth.example > recovery.pub.asc
scp recovery.pub.asc mirth-host:/tmp/
ssh mirth-host 'gpg --import /tmp/recovery.pub.asc'
```

The backup host can encrypt; only the recovery host has the private key to decrypt.

### Symmetric passphrase mode (simpler, less safe)

```bash
openssl rand -hex 32 > /etc/mirth/backup.passphrase
chmod 600 /etc/mirth/backup.passphrase
# Store the passphrase in a password manager / Vault. WITHOUT IT THE BACKUPS ARE BRICKS.
```

## Run a backup

```bash
# Public-key mode -> S3
./scripts/operations/backup-restore/backup.sh \
    --gpg-recipient recovery@mirth.example \
    --s3 s3://my-mirth-backups/prod \
    --mirth-host https://localhost:8443 \
    --pg-host    mirth-db.internal

# Symmetric mode, local only
./scripts/operations/backup-restore/backup.sh \
    --gpg-pass-file /etc/mirth/backup.passphrase \
    --out /var/backups/mirth

# See what would happen
./scripts/operations/backup-restore/backup.sh --gpg-pass-file /etc/mirth/backup.passphrase --dry-run
```

Output:
```
mirth-backup-20260528T020000Z.tar.gpg          <-- only encrypted artifact remains locally
mirth-backup-20260528T020000Z.tar.gpg.sha256
```

Schedule nightly @ 02:00:
```cron
0 2 * * * /opt/mirth-cookbook/scripts/operations/backup-restore/backup.sh \
          --gpg-recipient recovery@mirth.example \
          --s3 s3://my-mirth-backups/prod \
          >> /var/log/mirth/backup.log 2>&1
```

## Restore — tested procedure

### 1. Stage on the recovery host

```bash
# Stop the running Mirth instance (so we don't fight with REST imports)
docker stop mirth-connect

# Make sure pg_restore can talk to the DB and Mirth REST is up
psql -h mirth-db -U mirthdb -d mirthdb -c "SELECT version();"
curl -sk -u admin:admin https://localhost:8443/api/server/version

# Spin up Mirth in a clean state (so import doesn't conflict)
docker start mirth-connect
```

### 2. Run restore (with safety prompts)

```bash
./scripts/operations/backup-restore/restore.sh \
    --bundle s3://my-mirth-backups/prod/mirth-backup-20260528T020000Z.tar.gpg \
    --gpg-recipient recovery@mirth.example \
    --mirth-host https://localhost:8443 \
    --pg-host    mirth-db.internal

# Type YES at the confirm prompt. Use --yes to skip prompts in scripts.
```

### 3. Validate

```bash
# Channels imported?
curl -sk -u admin:admin https://localhost:8443/api/channels | grep '<name>' | head -10

# Channels started?
curl -sk -u admin:admin https://localhost:8443/api/channels/statuses

# Run a smoke message through one of the inbound listeners
( printf '\x0bMSH|^~\\&|SMOKE|TEST|MIRTH|MIRTH|20260528120000||ADT^A04|SMOKE01|P|2.5.1\r\x1c\r' ) | nc localhost 6661
```

### 4. Keystore restore (only on a fresh host)

```bash
./scripts/operations/backup-restore/restore.sh ... --apply-keystores
docker restart mirth-connect
```

## Rollback procedure (for a bad deploy)

You deployed a broken channel set — undo it without dropping the database:

```bash
# 1. Find the previous good backup
aws s3 ls s3://my-mirth-backups/prod/ | tail -5

# 2. Re-import ONLY channels + code templates (skip pg_restore)
gpg --decrypt mirth-backup-PREV.tar.gpg | tar -x
cd mirth-backup-PREV

curl -sk -u admin:admin -H 'Content-Type: application/xml' -X PUT \
     --data-binary @channels.xml \
     https://localhost:8443/api/channels?override=true

curl -sk -u admin:admin -H 'Content-Type: application/xml' -X PUT \
     --data-binary @codeTemplates.xml \
     https://localhost:8443/api/codeTemplates?override=true

# 3. Redeploy
curl -sk -u admin:admin -X POST https://localhost:8443/api/channels/_redeployAll
```

This is the fast (<5 min) rollback path. Use a full `restore.sh` only when the message database itself is also corrupt.

## What the bundle contains

```
mirth-backup-YYYYMMDDTHHMMSSZ/
├── mirthdb.dump           pg_dump -Fc (custom format, compressed)
├── channels.xml           every channel definition + deploy script
├── codeTemplates.xml      every code template library
├── alerts.xml             alert definitions
├── configurationMap.json  current configuration map values
├── keystores.tar.gz       /opt/connect/certs/
└── custom-lib.tar.gz      /opt/connect/custom-lib/
```

## S3 hardening checklist

- Bucket has **versioning enabled** (recover from "rm -rf" by listing versions)
- Bucket has **Object Lock = Compliance, 30 days** (immutable; ransomware can't delete)
- Bucket has **cross-region replication** to a second region
- Bucket policy denies `s3:DeleteObject` to the backup principal — let lifecycle rules expire old bundles, not humans
- CloudTrail data events enabled on the bucket — every Get is logged

## Verification (syntax)

```bash
bash -n scripts/operations/backup-restore/backup.sh  && echo "backup.sh ok"
bash -n scripts/operations/backup-restore/restore.sh && echo "restore.sh ok"
```

## Tested on

- Mirth Connect 4.5.2
- PostgreSQL 16 (pg_dump / pg_restore 16)
- AWS CLI v2.x
- GnuPG 2.4.x

## Author / License

Author: Nirmitee.io
License: MIT
