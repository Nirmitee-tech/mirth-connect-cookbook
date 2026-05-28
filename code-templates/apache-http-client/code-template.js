/**
 * Apache HttpClient Helper for Mirth Connect (Java 17 Compatible)
 *
 * Provides httpGet(), httpPost(), httpPut(), httpDelete() functions usable
 * from any transformer, source script, deploy script, or destination response transformer.
 *
 * REQUIREMENTS:
 *   1. Copy httpclient-4.5.13.jar + httpcore-4.4.13.jar to /opt/connect/custom-lib/
 *   2. Set server.includecustomlib = true in mirth.properties
 *   3. Restart Mirth
 *   4. DO NOT add slf4j-api JAR to custom-lib (classloader conflict)
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13, Apache HttpClient 4.5.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
var HttpGet = Packages.org.apache.http.client.methods.HttpGet;
var HttpPost = Packages.org.apache.http.client.methods.HttpPost;
var HttpPut = Packages.org.apache.http.client.methods.HttpPut;
var HttpDelete = Packages.org.apache.http.client.methods.HttpDelete;
var StringEntity = Packages.org.apache.http.entity.StringEntity;
var EntityUtils = Packages.org.apache.http.util.EntityUtils;
var RequestConfig = Packages.org.apache.http.client.config.RequestConfig;

/**
 * HTTP GET with configurable timeouts and headers.
 * @returns {{status: number, body: string, headers: object}}
 */
function httpGet(url, headers, options) {
    return httpRequest('GET', url, null, headers, options);
}

function httpPost(url, body, headers, options) {
    return httpRequest('POST', url, body, headers, options);
}

function httpPut(url, body, headers, options) {
    return httpRequest('PUT', url, body, headers, options);
}

function httpDelete(url, headers, options) {
    return httpRequest('DELETE', url, null, headers, options);
}

function httpRequest(method, url, body, headers, options) {
    options = options || {};
    var connectTimeout = options.connectTimeout || 5000;
    var socketTimeout = options.socketTimeout || 10000;

    // Build request based on method
    var request;
    if (method === 'GET') request = new HttpGet(url);
    else if (method === 'POST') request = new HttpPost(url);
    else if (method === 'PUT') request = new HttpPut(url);
    else if (method === 'DELETE') request = new HttpDelete(url);
    else throw new Error('Unsupported HTTP method: ' + method);

    // Apply timeouts
    var config = RequestConfig.custom()
        .setConnectTimeout(connectTimeout)
        .setSocketTimeout(socketTimeout)
        .build();
    request.setConfig(config);

    // Apply headers
    if (headers) {
        for (var key in headers) {
            request.addHeader(key, headers[key]);
        }
    }

    // Apply body for POST/PUT
    if (body && (method === 'POST' || method === 'PUT')) {
        var contentType = (headers && headers['Content-Type']) || 'application/json';
        request.setEntity(new StringEntity(body, 'UTF-8'));
    }

    var client = HttpClients.createDefault();
    var response = null;
    try {
        response = client.execute(request);
        var status = response.getStatusLine().getStatusCode();
        var responseBody = '';
        if (response.getEntity()) {
            responseBody = EntityUtils.toString(response.getEntity(), 'UTF-8');
        }

        // Collect response headers
        var respHeaders = {};
        var allHeaders = response.getAllHeaders();
        for (var i = 0; i < allHeaders.length; i++) {
            respHeaders[allHeaders[i].getName()] = allHeaders[i].getValue();
        }

        return {
            status: status,
            body: responseBody,
            headers: respHeaders
        };
    } finally {
        if (response != null) response.close();
        client.close();
    }
}

/**
 * Convenience: GET and parse JSON.
 * Throws if status >= 400 or body is not valid JSON.
 */
function httpGetJson(url, headers, options) {
    headers = headers || {};
    if (!headers['Accept']) headers['Accept'] = 'application/json';

    var result = httpGet(url, headers, options);
    if (result.status >= 400) {
        throw new Error('HTTP ' + result.status + ': ' + result.body);
    }
    return JSON.parse(result.body);
}

function httpPostJson(url, body, headers, options) {
    headers = headers || {};
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    headers['Accept'] = headers['Accept'] || 'application/json';

    var bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    var result = httpPost(url, bodyStr, headers, options);
    if (result.status >= 400) {
        throw new Error('HTTP ' + result.status + ': ' + result.body);
    }
    return result.body ? JSON.parse(result.body) : null;
}
