# Recipe #33 — HashiCorp Vault Integration for Mirth Connect

> Stop hardcoding API tokens, DB passwords, and OAuth client secrets in your channels' configurationMap. This recipe fetches them from Vault at runtime, caches with TTL, and supports zero-downtime rotation.

## What this recipe gives you

A Mirth Code Template library exposing:

| Function | Purpose |
|---|---|
| `vaultLogin()`                    | AppRole login; returns and caches a client token |
| `vaultGet(path, key, ttlSec)`     | fetch a single value, cached |
| `vaultGetAll(path, ttlSec)`       | fetch the whole secret object |
| `vaultRotate(path)`               | force the cache to refresh on next read |

## Why

- The Mirth Configuration Map is **stored in plaintext** at `appdata/configuration.properties`. Anyone with file-system access to the host can read every API token you put there.
- Hardcoding the token in a channel XML export means the secret leaks to git the moment somebody commits a backup.
- Vault gives you: short-lived dynamic credentials, a real audit log of every secret read, KV v2 versioning so you can rollback a bad rotation, and a single revoke point if a node is compromised.

## Prerequisites

| Item | Recipe / Notes |
|---|---|
| Apache HttpClient on `custom-lib/` with `httpGet`/`httpPost` helpers | Recipe #9 / `code-templates/apache-http-client/` |
| Vault server reachable from the Mirth host | https://vault.example.com:8200 |
| KV v2 secrets engine mounted (default `secret/`) | `vault secrets enable -path=secret kv-v2` |
| AppRole auth method enabled, with a role created for Mirth | see below |

### Provisioning an AppRole on Vault

```bash
# Enable AppRole
vault auth enable approle

# Policy: read-only on mirth/* paths
cat <<'EOF' | vault policy write mirth-read -
path "secret/data/mirth/*" {
  capabilities = ["read"]
}
EOF

# Create the role with a 30-min TTL token
vault write auth/approle/role/mirth-prod \
    token_policies="mirth-read" \
    token_ttl=30m \
    token_max_ttl=2h \
    secret_id_ttl=0 \
    secret_id_num_uses=0

# Grab the role_id (long-lived, can be baked into config map)
vault read auth/approle/role/mirth-prod/role-id
# Grab a secret_id (treat like a password — rotate per host)
vault write -f auth/approle/role/mirth-prod/secret-id

# Stash an example secret
vault kv put secret/mirth/destinations/labcorp \
    api_token="sk_live_AbCdEf123456" \
    base_url="https://api.labcorp.example.com"
```

## Install in Mirth

1. Make sure Recipe #9's `httpGet` / `httpPost` are available in a Code Template library named `HTTP` (or anything higher-precedence than `Security`).
2. Add a new library called `Security` (or reuse Recipe #31's).
3. Add a Code Template named `Vault Integration`, type `Function`, context `All`, and paste `code-template.js`.
4. Save and redeploy any channel that consumes secrets.

## Configuration map

Open Mirth Administrator -> **Server Settings -> Configuration Map**:

| Key | Example | Notes |
|---|---|---|
| `vault.addr`      | `https://vault.example.com:8200` | required |
| `vault.namespace` | empty or `admin/health/` | required only on Vault Enterprise |
| `vault.role_id`   | `1d9e9c2a-...` | AppRole role-id |
| `vault.secret_id` | `5a44ec2d-...` | **inject at boot from a file** (don't write the literal secret to the file system unless you have to). See "Bootstrapping the secret_id" below. |
| `vault.kv_mount`  | `secret` | KV v2 mount path |
| `vault.tls_skip`  | `false` | leave false; verify your CA |

### Bootstrapping the secret_id

The secret_id is itself a secret. Three good options:

1. **AppRole response wrapping** (recommended) — orchestrator wraps the secret_id with a single-use token; Mirth unwraps once on boot.
2. **Init container writes secret_id to a tmpfs file** that Mirth's deploy script reads into configurationMap.
3. **Environment variable** set by your secrets injector (e.g. Vault Agent), read in `globalDeployScript`:
   ```javascript
   configurationMap.put('vault.secret_id', java.lang.System.getenv('VAULT_SECRET_ID'));
   ```

## Usage

### Database Writer destination

```javascript
// In the Database Writer's "Use JavaScript = YES" preprocessor, or in a connector
// pre-transformer that swaps the URL/password into channelMap:
var dbCreds = vaultGetAll('mirth/db/clinical', 60);   // cache 60s
channelMap.put('db_url',      dbCreds.jdbc_url);
channelMap.put('db_user',     dbCreds.user);
channelMap.put('db_password', dbCreds.password);
```

Then in the Database Writer URL field: `${db_url}`, user `${db_user}`, password `${db_password}`.

### HTTP Sender to a downstream API

```javascript
var token = vaultGet('mirth/destinations/labcorp', 'api_token', 300);
var resp = httpPost('https://api.labcorp.example.com/orders', JSON.stringify(payload), {
    'Content-Type':  'application/json',
    'Authorization': 'Bearer ' + token
});
if (resp.status === 401) {
    // Token revoked or rotated — force refresh and retry once
    vaultRotate('mirth/destinations/labcorp');
    token = vaultGet('mirth/destinations/labcorp', 'api_token', 300);
    resp = httpPost('https://api.labcorp.example.com/orders', JSON.stringify(payload), {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token
    });
}
```

### OAuth2 client credentials (combine with Recipe #9 token cache)

```javascript
var clientId     = vaultGet('mirth/oauth/epic', 'client_id', 3600);
var clientSecret = vaultGet('mirth/oauth/epic', 'client_secret', 3600);
// ... pass to your http-sender-oauth2-jwt code template ...
```

## Verify

Cache-key uniqueness sanity check (verified):

```bash
node -e "
const m = require('./code-templates/vault-integration/code-template.js');
console.log(m._cacheKey('mirth/dest/labcorp','api_token'));
console.log(m._cacheKey('mirth/dest/labcorp', null));
console.log(m._cacheKey('mirth/dest/quest','api_token'));
"
# vault:mirth/dest/labcorp#api_token
# vault:mirth/dest/labcorp
# vault:mirth/dest/quest#api_token
```

End-to-end smoke test (against a real Vault):

```bash
# Inside the Mirth admin "JavaScript Test" panel (Tools -> Edit Code Templates -> ... right-click -> Test)
logger.info('token from vault: ' + vaultGet('mirth/destinations/labcorp', 'api_token', 5));
// First call:  POST /v1/auth/approle/login, GET /v1/secret/data/mirth/destinations/labcorp
// Subsequent calls within 5s: served from globalChannelMap
```

## Cache semantics

- `vaultGet(path, key, ttl)` and `vaultGetAll(path, ttl)` cache **per-process** in `globalChannelMap`.
- Mirth's `globalChannelMap` is server-wide (all channels) and survives redeploys but is wiped on JVM restart.
- The Vault **token** is cached separately and reused at 80% of its lease TTL — when 20% of the lease is left, the next call re-logs in.
- On `403 Forbidden`, the cached token is dropped and one automatic re-login is attempted.

## Rotation

Two flavours:

- **Vault-driven rotation** — you write a new version under the same KV path. Mirth picks it up after `ttlSeconds` expires, or call `vaultRotate(path)` from a deploy script to force-refresh immediately.
- **Mirth-detected rotation** — your downstream returns 401. The example above shows the call site invalidating its own cache and retrying once.

For shorter blast radius, use **dynamic database credentials** from Vault's database engine — Mirth gets a 1-hour DB password that auto-revokes.

## Audit

Every Vault read is logged in Vault's audit device. Tail it during rollouts:

```bash
vault audit list
sudo tail -f /var/log/vault/audit.log | jq 'select(.request.path | startswith("secret/data/mirth"))'
```

## Tested on

- Mirth Connect 4.5.2
- HashiCorp Vault 1.16 (OSS)
- Apache HttpClient 4.5.13 via Recipe #9

## Author / License

Author: Nirmitee.io
License: MIT
