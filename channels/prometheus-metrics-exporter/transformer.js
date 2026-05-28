/**
 * Prometheus Metrics Exporter for Mirth Connect (Java 17 Compatible)
 *
 * Source transformer for an HTTP Listener channel that exposes Mirth channel
 * statistics in Prometheus exposition format at GET /metrics.
 *
 * METRICS EMITTED:
 *   mirth_channel_received_total{channel="X",channelId="..."}  COUNTER
 *   mirth_channel_sent_total{channel="X",channelId="..."}      COUNTER
 *   mirth_channel_filtered_total{channel="X",channelId="..."}  COUNTER
 *   mirth_channel_errored_total{channel="X",channelId="..."}   COUNTER
 *   mirth_channel_queued{channel="X",channelId="..."}          GAUGE
 *   mirth_channel_state{channel="X",state="STARTED"}           GAUGE (1 or 0)
 *   mirth_scrape_duration_seconds                              GAUGE
 *
 * HOW IT WORKS:
 *   The HTTP Listener source accepts GET /metrics. This transformer calls
 *   Mirth's own REST API (/api/channels/statuses) using Apache HttpClient
 *   (avoiding the java.net.URL classloader bug on Java 17), parses the JSON,
 *   and assembles a text/plain Prometheus exposition response.
 *
 * WHERE TO INSTALL:
 *   1. Import the channel (channel.xml — TODO ship a copy) OR build it manually:
 *      - Source: HTTP Listener on /metrics, method GET, response from "Source"
 *      - Source Transformer: this script
 *      - Destinations: none (it's a "respond only" channel)
 *      - Response: set "Respond from" = Source. Response transformer pulls
 *        msg from channelMap.PROM_METRICS and returns it with
 *        Content-Type: text/plain; version=0.0.4
 *
 * REQUIREMENTS:
 *   - apache-http-client recipe installed (httpclient-4.5.13.jar,
 *     httpcore-4.4.13.jar in /opt/connect/custom-lib/, includecustomlib=true)
 *   - Channel admin credentials stored in configurationMap as:
 *       prom.mirth.url      e.g. https://localhost:8443/api
 *       prom.mirth.user     e.g. admin
 *       prom.mirth.password e.g. admin
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
var HttpClientBuilder = Packages.org.apache.http.impl.client.HttpClientBuilder;
var HttpGet = Packages.org.apache.http.client.methods.HttpGet;
var EntityUtils = Packages.org.apache.http.util.EntityUtils;
var BasicCredentialsProvider = Packages.org.apache.http.impl.client.BasicCredentialsProvider;
var UsernamePasswordCredentials = Packages.org.apache.http.auth.UsernamePasswordCredentials;
var AuthScope = Packages.org.apache.http.auth.AuthScope;
var SSLContextBuilder = Packages.org.apache.http.ssl.SSLContextBuilder;
var TrustAllStrategy = Packages.org.apache.http.conn.ssl.TrustAllStrategy;
var NoopHostnameVerifier = Packages.org.apache.http.conn.ssl.NoopHostnameVerifier;
var SSLConnectionSocketFactory = Packages.org.apache.http.conn.ssl.SSLConnectionSocketFactory;
var RequestConfig = Packages.org.apache.http.client.config.RequestConfig;
var System = Packages.java.lang.System;

var MIRTH_API = String(configurationMap.get('prom.mirth.url') || 'https://localhost:8443/api');
var MIRTH_USER = String(configurationMap.get('prom.mirth.user') || 'admin');
var MIRTH_PASS = String(configurationMap.get('prom.mirth.password') || 'admin');

var scrapeStart = System.currentTimeMillis();

try {
    var statuses = fetchChannelStatuses();
    var prom = renderPrometheus(statuses, (System.currentTimeMillis() - scrapeStart) / 1000.0);
    channelMap.put('PROM_METRICS', prom);
    channelMap.put('PROM_STATUS', 200);
} catch (e) {
    logger.error('Prometheus exporter failed: ' + e);
    channelMap.put('PROM_METRICS',
        '# HELP mirth_scrape_error Number of failed scrapes\n' +
        '# TYPE mirth_scrape_error counter\n' +
        'mirth_scrape_error 1\n');
    channelMap.put('PROM_STATUS', 500);
}

/**
 * Fetch channel statuses + statistics from Mirth's REST API.
 * @returns {Array<object>} array of {channelId, name, state, statistics, queued}
 */
function fetchChannelStatuses() {
    // 1) /channels/statuses → list of {channelId, name, state, queued, statistics}
    var json = mirthApiGet(MIRTH_API + '/channels/statuses');
    var parsed = JSON.parse(json);

    // The Mirth API returns DashboardStatus list under "list.dashboardStatus"
    // (older versions) or directly as an array (newer JSON wire format).
    var arr;
    if (parsed && parsed.list && parsed.list.dashboardStatus) {
        arr = parsed.list.dashboardStatus;
        if (!Array.isArray(arr)) arr = [arr];
    } else if (Array.isArray(parsed)) {
        arr = parsed;
    } else if (parsed && parsed.dashboardStatus) {
        arr = Array.isArray(parsed.dashboardStatus) ? parsed.dashboardStatus : [parsed.dashboardStatus];
    } else {
        arr = [];
    }
    return arr;
}

/**
 * Authenticated GET against Mirth's REST API.
 * Trusts self-signed certs (Mirth's default cert is self-signed).
 * @param {string} url
 * @returns {string} response body
 */
function mirthApiGet(url) {
    var creds = new BasicCredentialsProvider();
    creds.setCredentials(AuthScope.ANY, new UsernamePasswordCredentials(MIRTH_USER, MIRTH_PASS));

    var sslCtx = SSLContextBuilder.create()
        .loadTrustMaterial(null, new TrustAllStrategy())
        .build();
    var socketFactory = new SSLConnectionSocketFactory(sslCtx, NoopHostnameVerifier.INSTANCE);

    var cfg = RequestConfig.custom()
        .setConnectTimeout(3000)
        .setSocketTimeout(5000)
        .build();

    var client = HttpClientBuilder.create()
        .setDefaultCredentialsProvider(creds)
        .setSSLSocketFactory(socketFactory)
        .setDefaultRequestConfig(cfg)
        .build();

    var req = new HttpGet(url);
    req.addHeader('Accept', 'application/json');
    req.addHeader('X-Requested-With', 'prometheus-exporter');

    var response = null;
    try {
        response = client.execute(req);
        var status = response.getStatusLine().getStatusCode();
        var body = response.getEntity() ? EntityUtils.toString(response.getEntity(), 'UTF-8') : '';
        if (status >= 400) throw new Error('Mirth API ' + status + ': ' + body);
        return body;
    } finally {
        if (response != null) response.close();
        client.close();
    }
}

/**
 * Render Prometheus exposition text from a parsed status list.
 * @param {Array} statuses
 * @param {number} scrapeDurationSec
 * @returns {string} text/plain; version=0.0.4 body
 */
function renderPrometheus(statuses, scrapeDurationSec) {
    var lines = [];

    // HELP + TYPE blocks once
    lines.push('# HELP mirth_channel_received_total Messages received by the source connector');
    lines.push('# TYPE mirth_channel_received_total counter');
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        var labels = makeLabels(s);
        lines.push('mirth_channel_received_total' + labels + ' ' + statValue(s, 'received'));
    }

    lines.push('# HELP mirth_channel_sent_total Messages successfully sent by destination connectors');
    lines.push('# TYPE mirth_channel_sent_total counter');
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        lines.push('mirth_channel_sent_total' + makeLabels(s) + ' ' + statValue(s, 'sent'));
    }

    lines.push('# HELP mirth_channel_filtered_total Messages filtered out');
    lines.push('# TYPE mirth_channel_filtered_total counter');
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        lines.push('mirth_channel_filtered_total' + makeLabels(s) + ' ' + statValue(s, 'filtered'));
    }

    lines.push('# HELP mirth_channel_errored_total Messages that errored');
    lines.push('# TYPE mirth_channel_errored_total counter');
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        lines.push('mirth_channel_errored_total' + makeLabels(s) + ' ' + statValue(s, 'error'));
    }

    lines.push('# HELP mirth_channel_queued Messages currently queued for a destination');
    lines.push('# TYPE mirth_channel_queued gauge');
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        var q = (s.queued != null) ? s.queued : (s.statistics ? statValue(s, 'queued') : 0);
        lines.push('mirth_channel_queued' + makeLabels(s) + ' ' + Number(q));
    }

    lines.push('# HELP mirth_channel_state Channel state (1=in this state, 0=not)');
    lines.push('# TYPE mirth_channel_state gauge');
    var states = ['STARTED', 'STOPPED', 'PAUSED', 'STARTING', 'STOPPING', 'PAUSING', 'UNDEPLOYED'];
    for (var i = 0; i < statuses.length; i++) {
        var s = statuses[i];
        var current = String(s.state || 'UNDEPLOYED');
        for (var j = 0; j < states.length; j++) {
            var v = (current === states[j]) ? 1 : 0;
            lines.push('mirth_channel_state' + makeLabelsWithState(s, states[j]) + ' ' + v);
        }
    }

    lines.push('# HELP mirth_scrape_duration_seconds Time taken to scrape stats from Mirth API');
    lines.push('# TYPE mirth_scrape_duration_seconds gauge');
    lines.push('mirth_scrape_duration_seconds ' + scrapeDurationSec.toFixed(6));

    return lines.join('\n') + '\n';
}

function makeLabels(s) {
    var name = escapeLabel(String(s.name || ''));
    var id = escapeLabel(String(s.channelId || ''));
    return '{channel="' + name + '",channelId="' + id + '"}';
}

function makeLabelsWithState(s, state) {
    var name = escapeLabel(String(s.name || ''));
    var id = escapeLabel(String(s.channelId || ''));
    return '{channel="' + name + '",channelId="' + id + '",state="' + state + '"}';
}

function escapeLabel(v) {
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Extract a numeric stat value. Mirth's statistics object is keyed by status:
 *   { "RECEIVED": 123, "SENT": 120, "FILTERED": 1, "ERROR": 2, "QUEUED": 0 }
 * (Field name casing varies by version — handle both.)
 * @param {object} s - dashboard status
 * @param {string} key - one of received, sent, filtered, error, queued
 */
function statValue(s, key) {
    if (!s) return 0;
    var stats = s.statistics || s.stats || {};
    var upper = key.toUpperCase();
    var lower = key.toLowerCase();
    var candidates = [stats[upper], stats[lower], stats[key], s[upper], s[lower]];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i] != null && !isNaN(Number(candidates[i]))) return Number(candidates[i]);
    }
    return 0;
}
