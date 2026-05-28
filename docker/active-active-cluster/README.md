# Recipe #46 — Active-Active Mirth Cluster with PostgreSQL HA

**Description:** Two-node active-active Mirth Connect cluster fronted by HAProxy, backed by a streaming-replicated PostgreSQL pair. Uses database-level shared state (the OSS workaround for the commercial Advanced Clustering plugin).

**Use case:** Hospitals / labs that need HL7 v2 MLLP ingestion to survive a Mirth node restart, OS patching, or AZ failure — without paying for the commercial clustering license.

**Requirements:**
- Docker 24+ and Docker Compose v2
- 4 GB RAM free
- Ports `6661`, `8443`, `8444`, `5433` available on host

**Tested on:** Mirth Connect `4.5.2` (image `nextgenhealthcare/connect:4.5.2`), PostgreSQL `16`, HAProxy `2.9`.
**Author:** Nirmitee.io | **License:** MIT

---

## What this gives you

```
                   ┌────────────────────────┐
   HL7 v2 ─MLLP──▶ │ HAProxy (port 6661)    │ ──┬──▶ mirth-1 :6661
                   │  round-robin + checks  │   └──▶ mirth-2 :6661
                   └────────────────────────┘
                              │
                   ┌──────────┴───────────┐
                   │ pg-primary  ◀──WAL──┐│
                   │ (writes)            ││
                   └─────────┬───────────┘│
                             │  streaming │
                             ▼            │
                   ┌─────────────────────┐│
                   │ pg-standby (read)   ││
                   └─────────────────────┘
```

Both Mirth nodes connect to `pg-primary` as their backend store. Channel deployments, message store, audit log, and user accounts are all shared automatically — that's the trick.

## Why not the commercial Advanced Clustering plugin?

NextGen's Advanced Clustering plugin (paid) gives you:
- Channel state synchronization (deploy on one, deploys everywhere)
- Distributed locks for source connectors that shouldn't run in parallel (file reader, DB reader)
- Automatic failover of "leader-only" channels

This recipe gives you **half** of that for free:
- Shared message store, channel definitions, user accounts (DB-level)
- Load-balanced MLLP / HTTPS ingress

What you have to handle yourself:
- **Channel deploys** — deploy via the API to *both* nodes, or use the promotion recipe (#50)
- **Single-writer source connectors** — pin them to one node (set the channel as deployed only on `mirth-1`, or use a dedicated 3rd "reader" node)
- **Attachment storage** — point `attachments.store.directory` at a shared filesystem (NFS / EFS) — see `docker-compose.yml` `mirth-attachments` volume

## Setup

```bash
cd docker/active-active-cluster
docker compose up -d
```

Wait ~60 seconds, then confirm:

```bash
docker compose ps                          # all 5 containers Up + healthy
curl -sk https://localhost:8443/api/server/version    # mirth-1
curl -sk https://localhost:8444/api/server/version    # mirth-2
```

HAProxy stats page: <http://localhost:8404/stats> (admin / admin)

## Test failover

Run the included script:

```bash
./test-failover.sh
```

It will:
1. Send 20 ADT^A01 messages through the HAProxy MLLP listener (port `6661`).
2. Confirm both `mirth-1` and `mirth-2` processed roughly half each.
3. `docker stop mirth-1`, then send 20 more messages.
4. Confirm `mirth-2` picked up 100% of the new traffic.
5. `docker start mirth-1`, wait for health, send 20 more.
6. Confirm load is balanced again.

Expected output ends with `[ok] active-active cluster failover verified`.

## Customize

- **More nodes:** copy the `mirth-2` service block, add a `server mirth-3 mirth-3:6661 check` line to `haproxy.cfg`, restart HAProxy.
- **Different MLLP ports:** add `bind *:6662`, `bind *:6663`, etc. to the `frontend mllp_in` block; expose them in `docker-compose.yml`.
- **Real TLS for the admin API:** put a second HAProxy `frontend admin_https` on `8443` with SSL termination using your own cert.
- **Production PostgreSQL:** swap `pg-primary` + `pg-standby` for managed RDS Multi-AZ (see recipe #48) — the Mirth nodes won't notice.

## Limitations (read this before going to prod)

1. **Channel deploy is not automatic.** If you deploy a channel on `mirth-1`, `mirth-2` won't load it until you also deploy there. Use recipe #50's `promote.sh` to push to both nodes.
2. **No cluster-wide channel locks.** A file reader on a shared NFS mount, deployed on both nodes, will double-process. Pin those channels.
3. **Streaming replication is async by default.** A primary loss during a write window can lose the last few seconds of messages. For zero-data-loss, switch to synchronous replication (set `synchronous_standby_names` and accept the latency cost).
4. **HAProxy is a SPOF in this compose.** In prod, run two HAProxys with `keepalived` / VRRP, or use a cloud LB (NLB).
5. **The standby is read-only and not used by Mirth.** It exists for DR — if `pg-primary` dies, you promote `pg-standby` and re-point both Mirth nodes (manual). Use a tool like `repmgr` or `Patroni` for automated promotion.

## File listing

| File | Purpose |
|---|---|
| `docker-compose.yml` | 5 services: 2 Mirth, PG primary, PG standby, HAProxy |
| `haproxy.cfg` | MLLP TCP load balancer + admin API stats |
| `pg-primary-init.sh` | Configures replication on primary |
| `pg-standby-init.sh` | Bootstraps standby via `pg_basebackup` |
| `test-failover.sh` | End-to-end failover verification |
