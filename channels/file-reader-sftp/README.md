# SFTP File Reader with Rotation & Archival

Production-grade source connector that polls an SFTP server every 5 minutes, processes each file exactly once across a Mirth cluster, and archives by date. Failed files are quarantined under `/error/yyyy-mm-dd/` for triage.

## What it does

```
sftp.example.com:/upload/inbound/
        │                           (Mirth polls every 5 min)
        ▼
    lab_123.hl7                     (1) rename → lab_123.hl7.processing  (locks it)
        │
        ▼
    Mirth reads file → channel pipeline → destinations
        │
        ├── ALL SENT  ─►  /upload/archive/2026-05-28/lab_123.hl7
        └── ANY ERROR ─►  /upload/error/2026-05-28/lab_123.hl7  + failure reasons in logs
```

Key properties:

- **Exactly-once per cluster**: `<file>.lock` sentinel on the SFTP server prevents two Mirth nodes from racing on the same file.
- **Rename-during-read**: file is renamed to `<file>.processing` before any read, so external watchers / cron jobs ignore it.
- **Daily buckets**: archive and error directories are bucketed by `yyyy-mm-dd` for easy janitor jobs (`find /upload/archive/2026-04-* -delete`).
- **Replay-safe**: if `lab_123.hl7` already exists in today's archive (re-delivery), we append `.<epoch>` so nothing is overwritten.
- **Recursive scan optional** via `sftp.recursive` in configurationMap.

## Why this design

Most teams start with Mirth's built-in "Move file to ..." setting, but that:

- Doesn't bucket by date — archive directory grows unbounded.
- Doesn't separate success from failure — a 4xx HTTP at the destination still moves the file to "archive".
- Doesn't lock — a second Mirth node in HA can double-process.

The post-process script in [javascript/post-process-script.js](javascript/post-process-script.js) inspects `responseMap` for every destination and only archives if **all** destinations returned `SENT`. Otherwise the file goes to `error/` with reasons logged.

## Where to install

1. **Channel → Source → Connector type:** File Reader
2. Configure:
   - **Method:** SFTP
   - **Host:** `${sftp.host}`  **Port:** `${sftp.port}`
   - **Username / Password:** `${sftp.user}` / `${sftp.pass}` (from Settings → Configuration Map)
   - **Directory:** `/upload/inbound`
   - **File Filter:** `*.hl7` (or whatever pattern fits)
   - **Recursive:** check if you want subfolders scanned
   - **Polling Type:** Interval → `300000` ms (5 min)
   - **Move-to file:** `${originalFilename}.processing`  ← this is the in-flight rename
   - **After processing action:** **None** (we manage it from the post-processor)
3. **Channel → Scripts → Postprocessor:** paste [post-process-script.js](javascript/post-process-script.js).
4. **Settings → Configuration Map:** add the keys listed under [Configurable values](#configurable-values) below.
5. Deploy.

## Configurable values

All are read from `configurationMap` at script load. Override per environment without editing code:

| Key | Default | Purpose |
|---|---|---|
| `sftp.host` | `sftp.example.com` | Hostname for post-process moves |
| `sftp.port` | `22` | Port |
| `sftp.user` | `mirth` | Username |
| `sftp.pass` | `changeme` | Password (use keys in production — see below) |
| `sftp.inbound.dir` | `/upload/inbound` | Where files arrive |
| `sftp.archive.dir` | `/upload/archive` | Base for `yyyy-mm-dd/` buckets on success |
| `sftp.error.dir` | `/upload/error` | Base for `yyyy-mm-dd/` buckets on failure |
| `sftp.recursive` | `false` | If `true`, also scan subdirectories |

## docker-compose snippet (SFTP container for local testing)

Add to `docker/docker-compose.yml`:

```yaml
  sftp:
    image: atmoz/sftp:alpine
    container_name: mirth-sftp
    ports:
      - "2222:22"
    volumes:
      - ./sftp-data:/home/mirth/upload
      - ./sftp-keys/ssh_host_rsa_key:/etc/ssh/ssh_host_rsa_key:ro
      - ./sftp-keys/ssh_host_ed25519_key:/etc/ssh/ssh_host_ed25519_key:ro
    command: mirth:changeme:1001:1001:upload/inbound,upload/archive,upload/error
    restart: unless-stopped
```

Then:

```bash
mkdir -p docker/sftp-data/mirth/upload/{inbound,archive,error}
docker compose up -d sftp
# Test connection
sftp -P 2222 mirth@localhost     # password: changeme
```

In Mirth Administrator, point the channel at `host=host.docker.internal port=2222 user=mirth pass=changeme`.

## Test

1. **Drop a test HL7v2 file**:

   ```bash
   sftp -P 2222 mirth@localhost <<EOF
   cd upload/inbound
   put sample-data/hl7v2/adt-a01.hl7
   quit
   EOF
   ```

2. **Wait for the next poll** (≤5 min) or hit *Channel → Action → Poll Now*.

3. **Verify the rename**:

   ```bash
   sftp -P 2222 mirth@localhost <<EOF
   ls upload/inbound
   ls upload/archive
   quit
   EOF
   ```

   You should see the file gone from `inbound/`, present in `archive/yyyy-mm-dd/adt-a01.hl7`, and the channel dashboard showing 1 message SENT.

4. **Test the error path** — force a destination to fail (e.g. point the MLLP Sender at an unreachable host) and resend. The file should land in `error/yyyy-mm-dd/` and the channel log should print:

   ```
   SFTP post-process: adt-a01.hl7 → ERROR at /upload/error/2026-05-28/adt-a01.hl7 reasons=Destination 1:ERROR (Connection refused)
   ```

5. **Test concurrent locking** — spin up a second Mirth node pointing at the same SFTP, both with this channel deployed. Drop 100 files. Verify no file appears in both `archive/` *and* `error/`, and that no two nodes process the same file (check logs for `Another node is processing ...`).

## Customize

- **Switch to key auth**: replace `session.setPassword(...)` in the script with:

  ```js
  jsch.addIdentity('/opt/mirth/.ssh/id_ed25519', SFTP_PASS /* passphrase, optional */);
  ```

  and add the key file to your Mirth host. Drop the password from configurationMap.

- **Per-tenant subfolders**: set `sftp.recursive=true` and parse the tenant from `sourceMap.get('fileDirectory')` in your transformer to route per-tenant.

- **Different bucket granularity**: change `todayBucket()` to `yyyy/MM/dd` (3 directory levels) for very-high-volume installations (>100k files/day) to avoid one directory bloating.

- **Retention**: schedule a cron in the SFTP container to delete archives older than N days:

  ```bash
  find /home/mirth/upload/archive -mindepth 1 -maxdepth 1 -type d -mtime +90 -exec rm -rf {} \;
  ```

## Production considerations

- **Use SSH keys, not passwords**. Mirth's configuration map persists in plain text on disk.
- **Network**: put Mirth and the SFTP server on the same VPC; the rename + lock dance does 4 SFTP roundtrips per file. ~15 ms LAN is fine, 150 ms WAN will rate-limit you below ~50 files/min.
- **Lock cleanup**: if Mirth crashes mid-process, the `.lock` file stays. Add a janitor channel that deletes any `*.lock` older than 2× max processing time (e.g. 30 min).
- **Mirth HA**: this script is safe across a Mirth cluster because the lock is on the SFTP server, not in `globalChannelMap`. With Mirth's built-in clustering, the polling itself is leader-elected, but the lock provides defense-in-depth.

## Files

- [javascript/post-process-script.js](javascript/post-process-script.js) — the post-processor
