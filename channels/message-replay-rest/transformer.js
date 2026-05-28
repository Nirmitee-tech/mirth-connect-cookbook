/**
 * Message Replay REST Endpoint for Mirth Connect (Java 17 Compatible)
 *
 * Source transformer for an HTTP Listener channel that exposes a small REST
 * API for replaying messages from any channel — typically used in concert with
 * the dead-letter-queue channel to bulk-replay failed messages once a
 * downstream is healthy again.
 *
 * ROUTES (path matched by source HTTP Listener Base Context = /replay):
 *   POST /replay/{channelId}/{messageId}          → replay one message
 *   POST /replay/{channelId}?fromId=X&toId=Y      → range replay
 *
 *   Optional query params:
 *     replaceFiltered=true   - re-run filters too (default true)
 *     transformerOnly=true   - re-run transformer but DO NOT send to destinations
 *                              (Mirth maps this to `replaceCurrentTask=true`,
 *                               `reprocess` API behavior)
 *
 * AUTH:
 *   Required header  X-Replay-Token: <value>
 *   Validated against globalMap.get('replay.token'). Set at deploy time.
 *
 * RESPONSE:
 *   200 { "status": "ok", "replayed": N }
 *   401 { "status": "error", "error": "missing or invalid X-Replay-Token" }
 *   400 { "status": "error", "error": "bad path" }
 *   502 { "status": "error", "error": "<Mirth API error>" }
 *
 * REQUIREMENTS:
 *   - apache-http-client recipe installed (used to call Mirth's own REST API)
 *   - configurationMap:
 *       replay.mirth.url       e.g. https://localhost:8443/api
 *       replay.mirth.user      e.g. admin
 *       replay.mirth.password  e.g. admin
 *   - globalMap:
 *       replay.token           — bearer-like token clients must present
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
var HttpClientBuilder = Packages.org.apache.http.impl.client.HttpClientBuilder;
var HttpPost = Packages.org.apache.http.client.methods.HttpPost;
var StringEntity = Packages.org.apache.http.entity.StringEntity;
var EntityUtils = Packages.org.apache.http.util.EntityUtils;
var BasicCredentialsProvider = Packages.org.apache.http.impl.client.BasicCredentialsProvider;
var UsernamePasswordCredentials = Packages.org.apache.http.auth.UsernamePasswordCredentials;
var AuthScope = Packages.org.apache.http.auth.AuthScope;
var SSLContextBuilder = Packages.org.apache.http.ssl.SSLContextBuilder;
var TrustAllStrategy = Packages.org.apache.http.conn.ssl.TrustAllStrategy;
var NoopHostnameVerifier = Packages.org.apache.http.conn.ssl.NoopHostnameVerifier;
var SSLConnectionSocketFactory = Packages.org.apache.http.conn.ssl.SSLConnectionSocketFactory;
var RequestConfig = Packages.org.apache.http.client.config.RequestConfig;

var MIRTH_API  = String(configurationMap.get('replay.mirth.url')      || 'https://localhost:8443/api');
var MIRTH_USER = String(configurationMap.get('replay.mirth.user')     || 'admin');
var MIRTH_PASS = String(configurationMap.get('replay.mirth.password') || 'admin');
var REPLAY_TOK = String(globalMap.get('replay.token')                 || '');

// HTTP Listener exposes the request via the incoming msg payload and the
// `sourceMap` headers/params. We need to extract method, path, query, headers.
var method      = String(sourceMap.get('method')                 || 'POST').toUpperCase();
var contextPath = String(sourceMap.get('contextPath')            || '');
var fullPath    = String(sourceMap.get('uri')                    || contextPath);
var query       = sourceMap.get('parameters') || {};
var authToken   = String(sourceMap.get('X-Replay-Token') || sourceMap.get('x-replay-token') || '');

try {
    if (method !== 'POST') {
        return respond(405, { status: 'error', error: 'method not allowed' });
    }

    if (!REPLAY_TOK || authToken !== REPLAY_TOK) {
        return respond(401, { status: 'error', error: 'missing or invalid X-Replay-Token' });
    }

    var parsed = parsePath(fullPath);
    if (!parsed.channelId) {
        return respond(400, { status: 'error', error: 'bad path; expected /replay/{channelId}/{messageId} or /replay/{channelId}?fromId=X&toId=Y' });
    }

    var transformerOnly = String(query.get ? query.get('transformerOnly') : query['transformerOnly']) === 'true';
    var replaceFiltered = String(query.get ? query.get('replaceFiltered') : query['replaceFiltered']) !== 'false';
    var fromId          = query.get ? query.get('fromId') : query['fromId'];
    var toId            = query.get ? query.get('toId')   : query['toId'];

    var replayed;
    if (parsed.messageId) {
        replayed = reprocessOne(parsed.channelId, parsed.messageId, replaceFiltered, transformerOnly);
    } else if (fromId && toId) {
        replayed = reprocessRange(parsed.channelId, String(fromId), String(toId), replaceFiltered, transformerOnly);
    } else {
        return respond(400, { status: 'error', error: 'either /{messageId} or ?fromId=X&toId=Y is required' });
    }

    return respond(200, { status: 'ok', replayed: replayed, channelId: parsed.channelId });

} catch (e) {
    logger.error('replay error: ' + e);
    return respond(502, { status: 'error', error: String(e) });
}

/**
 * Parse the request URI into channelId + optional messageId.
 * Accepts both /replay/{cid}/{mid} and /replay/{cid}.
 * @param {string} uri
 * @returns {{channelId: string|null, messageId: string|null}}
 */
function parsePath(uri) {
    // strip query string if present
    var qIdx = uri.indexOf('?');
    var clean = (qIdx >= 0) ? uri.substring(0, qIdx) : uri;

    // expected: /replay/{channelId} or /replay/{channelId}/{messageId}
    // also accept /dlq/replay/{messageId} which routes through the dlq lookup
    var parts = clean.split('/').filter(function(p) { return p.length > 0; });

    // Strip "replay" prefix if present
    if (parts.length > 0 && parts[0] === 'replay') parts = parts.slice(1);
    // Or /dlq/replay prefix
    if (parts.length > 1 && parts[0] === 'dlq' && parts[1] === 'replay') parts = parts.slice(2);

    if (parts.length === 0) return { channelId: null, messageId: null };
    if (parts.length === 1) return { channelId: parts[0], messageId: null };
    return { channelId: parts[0], messageId: parts[1] };
}

/**
 * Call Mirth's /channels/{channelId}/messages/_reprocess for a single message.
 * @returns {number} 1 on success, throws on failure
 */
function reprocessOne(channelId, messageId, replaceFiltered, transformerOnly) {
    var url = MIRTH_API + '/channels/' + encodeURIComponent(channelId) +
        '/messages/_reprocess?replaceFilterDestination=' + replaceFiltered;

    // Mirth API accepts a MessageFilter body limiting which messages to replay.
    // For single-message we use a simple {includeMessages:[id]} payload.
    var body = JSON.stringify({
        messageFilter: {
            includedMessageIds: [Number(messageId)],
            excludedMessageIds: []
        },
        transformerOnly: !!transformerOnly
    });

    var status = mirthApiPost(url, body);
    if (status >= 200 && status < 300) return 1;
    throw new Error('reprocess ' + messageId + ' failed: HTTP ' + status);
}

/**
 * Range replay — let Mirth's API enumerate IDs in [fromId, toId].
 * @returns {string} "range:<from>-<to>" (Mirth doesn't return exact count)
 */
function reprocessRange(channelId, fromId, toId, replaceFiltered, transformerOnly) {
    var url = MIRTH_API + '/channels/' + encodeURIComponent(channelId) +
        '/messages/_reprocess?replaceFilterDestination=' + replaceFiltered;

    var body = JSON.stringify({
        messageFilter: {
            // Mirth's MessageFilter supports min/max message ID bounds
            minMessageId: Number(fromId),
            maxMessageId: Number(toId)
        },
        transformerOnly: !!transformerOnly
    });

    var status = mirthApiPost(url, body);
    if (status >= 200 && status < 300) return 'range:' + fromId + '-' + toId;
    throw new Error('range reprocess failed: HTTP ' + status);
}

/**
 * Authenticated POST to Mirth API. Returns HTTP status code.
 * @param {string} url
 * @param {string} body
 * @returns {number}
 */
function mirthApiPost(url, body) {
    var creds = new BasicCredentialsProvider();
    creds.setCredentials(AuthScope.ANY, new UsernamePasswordCredentials(MIRTH_USER, MIRTH_PASS));

    var sslCtx = SSLContextBuilder.create().loadTrustMaterial(null, new TrustAllStrategy()).build();
    var sf = new SSLConnectionSocketFactory(sslCtx, NoopHostnameVerifier.INSTANCE);
    var cfg = RequestConfig.custom().setConnectTimeout(3000).setSocketTimeout(10000).build();

    var client = HttpClientBuilder.create()
        .setDefaultCredentialsProvider(creds)
        .setSSLSocketFactory(sf)
        .setDefaultRequestConfig(cfg)
        .build();

    var req = new HttpPost(url);
    req.addHeader('Content-Type', 'application/json');
    req.addHeader('Accept', 'application/json');
    req.addHeader('X-Requested-With', 'mirth-replay-rest');
    req.setEntity(new StringEntity(body, 'UTF-8'));

    var response = null;
    try {
        response = client.execute(req);
        var status = response.getStatusLine().getStatusCode();
        // Drain body so connection can return to pool / be closed
        if (response.getEntity()) EntityUtils.toString(response.getEntity(), 'UTF-8');
        return status;
    } finally {
        if (response != null) response.close();
        client.close();
    }
}

/**
 * Pack the JSON response for the HTTP Listener response transformer to send.
 * @param {number} status
 * @param {object} bodyObj
 */
function respond(status, bodyObj) {
    channelMap.put('REPLAY_STATUS', status);
    channelMap.put('REPLAY_BODY', JSON.stringify(bodyObj));
    return JSON.stringify(bodyObj);
}
