/**
 * Recipe #33 — HashiCorp Vault Integration for Mirth Connect
 *
 * Fetches secrets from Vault's KV v2 engine at runtime using AppRole auth.
 * Caches secrets in configurationMap with TTL so we don't hit Vault on every
 * message. Built on Apache HttpClient (Recipe #9 prerequisite).
 *
 * REQUIREMENTS:
 *   1. Apache HttpClient on custom-lib (see code-templates/apache-http-client/)
 *   2. The httpPost/httpGet helpers from that template available in a higher-
 *      precedence Code Template library called "HTTP".
 *   3. Set in configurationMap:
 *         vault.addr        = https://vault.example.com:8200
 *         vault.namespace   = (empty or 'admin/health/')
 *         vault.role_id     = <UUID from AppRole>
 *         vault.secret_id   = <UUID from AppRole>
 *         vault.kv_mount    = secret           (KV v2 mount path)
 *         vault.tls_skip    = false
 *
 *   4. Paste into Code Templates -> Library 'Security' -> Type Function -> Context All.
 *
 * Public API:
 *   vaultGet(path, key, ttlSeconds)  — fetch a single key, cached
 *   vaultGetAll(path, ttlSeconds)    — fetch the whole secret object
 *   vaultRotate(path)                — invalidate cache for one path
 *   vaultLogin()                     — force a re-login (e.g. on 403)
 *
 * Tested on: Mirth Connect 4.5.2, Vault 1.16, Apache HttpClient 4.5.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

/* ---------------- Cache helpers (globalChannelMap) ----------------------- */
function _gcGet(k)    { try { return globalChannelMap.get(k); } catch (e) { return null; } }
function _gcPut(k, v) { try { globalChannelMap.put(k, v); } catch (e) {} }

function _cacheKey(path, key) { return 'vault:' + path + (key ? ('#' + key) : ''); }

function _cacheGet(path, key) {
    var raw = _gcGet(_cacheKey(path, key));
    if (!raw) return null;
    try {
        var obj = JSON.parse(raw);
        if (obj.expiresAt && obj.expiresAt > Date.now()) return obj.value;
    } catch (e) {}
    return null;
}
function _cachePut(path, key, value, ttlSeconds) {
    _gcPut(_cacheKey(path, key), JSON.stringify({
        value:     value,
        expiresAt: Date.now() + (ttlSeconds * 1000)
    }));
}

/* ---------------- Vault HTTP plumbing ------------------------------------ */
function _vaultUrl(suffix) {
    var base = String(configurationMap.get('vault.addr') || '').replace(/\/+$/, '');
    if (!base) throw new Error('configurationMap[vault.addr] is not set');
    return base + suffix;
}
function _vaultHeaders(token) {
    var h = { 'Content-Type': 'application/json' };
    var ns = configurationMap.get('vault.namespace');
    if (ns) h['X-Vault-Namespace'] = String(ns);
    if (token) h['X-Vault-Token'] = String(token);
    return h;
}

/**
 * AppRole login. Returns a client token cached for the lease duration.
 * Re-uses the cached token until ~80% of its TTL has elapsed.
 */
function vaultLogin() {
    var cached = _gcGet('vault:token');
    if (cached) {
        try {
            var t = JSON.parse(cached);
            if (t.expiresAt - 60_000 > Date.now()) return t.token;
        } catch (e) {}
    }
    var body = JSON.stringify({
        role_id:   String(configurationMap.get('vault.role_id')   || ''),
        secret_id: String(configurationMap.get('vault.secret_id') || '')
    });
    var resp = httpPost(_vaultUrl('/v1/auth/approle/login'), body, _vaultHeaders(null), { socketTimeout: 5000 });
    if (resp.status !== 200) {
        throw new Error('Vault AppRole login failed: ' + resp.status + ' ' + resp.body);
    }
    var data  = JSON.parse(resp.body);
    var token = data.auth && data.auth.client_token;
    var lease = (data.auth && data.auth.lease_duration) || 1800; // seconds
    if (!token) throw new Error('Vault login response missing client_token');
    _gcPut('vault:token', JSON.stringify({
        token:     token,
        expiresAt: Date.now() + (lease * 800)  // 80% of TTL
    }));
    return token;
}

function _vaultRead(path) {
    var mount = String(configurationMap.get('vault.kv_mount') || 'secret');
    var url   = _vaultUrl('/v1/' + mount + '/data/' + path.replace(/^\/+/, ''));
    var token = vaultLogin();
    var resp  = httpGet(url, _vaultHeaders(token), { socketTimeout: 5000 });
    if (resp.status === 403) {
        // Token may have been revoked or expired — force re-login once
        _gcPut('vault:token', null);
        token = vaultLogin();
        resp  = httpGet(url, _vaultHeaders(token), { socketTimeout: 5000 });
    }
    if (resp.status !== 200) {
        throw new Error('Vault read ' + path + ' failed: ' + resp.status + ' ' + resp.body);
    }
    var parsed = JSON.parse(resp.body);
    return (parsed.data && parsed.data.data) || {};   // KV v2 nests under data.data
}

/* ---------------- Public API --------------------------------------------- */

/**
 * Get a single secret key from Vault, cached for ttlSeconds.
 * @param {string} path           e.g. 'mirth/destinations/labcorp'
 * @param {string} key            e.g. 'api_token'
 * @param {number} [ttlSeconds]   default 300
 * @returns {string}
 */
function vaultGet(path, key, ttlSeconds) {
    ttlSeconds = ttlSeconds || 300;
    var cached = _cacheGet(path, key);
    if (cached !== null) return cached;
    var data = _vaultRead(path);
    if (!data.hasOwnProperty(key)) {
        throw new Error('Vault path ' + path + ' has no key "' + key + '"');
    }
    _cachePut(path, key, data[key], ttlSeconds);
    return data[key];
}

/**
 * Get the whole secret object at a path.
 * @returns {object}
 */
function vaultGetAll(path, ttlSeconds) {
    ttlSeconds = ttlSeconds || 300;
    var cached = _cacheGet(path, null);
    if (cached !== null) return cached;
    var data = _vaultRead(path);
    _cachePut(path, null, data, ttlSeconds);
    return data;
}

/**
 * Invalidate the cache for one path. Call from a deploy script or on a 401
 * response from the downstream system.
 */
function vaultRotate(path) {
    var prefix = 'vault:' + path;
    try {
        // No iterate API on globalChannelMap — clear known keys directly.
        var data = _vaultRead(path);
        for (var k in data) {
            if (data.hasOwnProperty(k)) _gcPut(prefix + '#' + k, null);
        }
        _gcPut(prefix, null);
    } catch (e) {
        _gcPut(prefix, null);
    }
}

/* ---------------- Node test export --------------------------------------- */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // Exposed for testing without configurationMap/httpPost
        _cacheKey: _cacheKey
    };
}
