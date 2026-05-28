# Apache HttpClient for Mirth Connect (Java 17 Working Solution)

> The pattern that fixes the `java.net.URL` classloader bug in Mirth Connect on Java 17.

## The Problem

In Mirth Connect 4.5.2 running on Java 17, calling external APIs from a JavaScript transformer using `java.net.URL` produces:

```
java.lang.IllegalAccessException: class org.mozilla.javascript.MemberBox cannot access
class sun.net.www.protocol.http.HttpURLConnection (in module java.base) because module
java.base does not export sun.net.www.protocol.http to unnamed module
```

This is [GitHub issue #6254](https://github.com/nextgenhealthcare/connect/issues/6254). Open as of 2026.

## The Solution

Use Apache HttpComponents HttpClient 4.x via `Packages.org.apache.http`. It's bundled in Mirth's `server-lib/commons/` but not on the Rhino classpath by default. You must:

1. Copy `httpclient-4.5.13.jar` + `httpcore-4.4.13.jar` to `custom-lib/`
2. Set `server.includecustomlib = true` in `mirth.properties`
3. **Do NOT** add `slf4j-api` to `custom-lib/` — it conflicts with Mirth's internal SLF4J via `ChildFirstURLClassLoader`
4. Restart Mirth

## Setup

```bash
# Copy JARs from Mirth's server-lib to custom-lib
docker exec mirth-connect cp /opt/connect/server-lib/commons/httpclient-4.5.13.jar /opt/connect/custom-lib/
docker exec mirth-connect cp /opt/connect/server-lib/commons/httpcore-4.4.13.jar /opt/connect/custom-lib/

# Enable custom-lib
docker exec mirth-connect sed -i 's/server.includecustomlib = false/server.includecustomlib = true/' /opt/connect/conf/mirth.properties

# Restart
docker restart mirth-connect
```

## Usage in a Mirth Transformer or Code Template

```javascript
// Reusable HTTP GET function for Mirth transformers
function httpGet(url, headers) {
    var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
    var HttpGet = Packages.org.apache.http.client.methods.HttpGet;
    var EntityUtils = Packages.org.apache.http.util.EntityUtils;

    var client = HttpClients.createDefault();
    var request = new HttpGet(url);

    if (headers) {
        for (var key in headers) {
            request.addHeader(key, headers[key]);
        }
    }

    var response = null;
    try {
        response = client.execute(request);
        var status = response.getStatusLine().getStatusCode();
        var body = EntityUtils.toString(response.getEntity(), 'UTF-8');
        return { status: status, body: body };
    } finally {
        if (response != null) response.close();
        client.close();
    }
}

// Example: validate ICD-10 code against tx.fhir.org
function validateICD10(code) {
    var url = 'https://tx.fhir.org/r4/CodeSystem/$lookup?system=' +
              java.net.URLEncoder.encode('http://hl7.org/fhir/sid/icd-10-cm', 'UTF-8') +
              '&code=' + java.net.URLEncoder.encode(code, 'UTF-8');

    var result = httpGet(url, { 'Accept': 'application/fhir+json' });

    if (result.status === 200) {
        var data = JSON.parse(result.body);
        for (var i = 0; i < data.parameter.length; i++) {
            if (data.parameter[i].name === 'display') {
                return data.parameter[i].valueString;
            }
        }
    }
    return null;
}

// Use it in a transformer
var diagnosis = msg['DG1']['DG1.3']['DG1.3.1'].toString();
var validatedDisplay = validateICD10(diagnosis);
if (validatedDisplay) {
    channelMap.put('icdValidated', validatedDisplay);
    logger.info('TX SERVER: ' + diagnosis + ' validated as ' + validatedDisplay);
}
```

## POST Example

```javascript
function httpPost(url, body, headers) {
    var HttpClients = Packages.org.apache.http.impl.client.HttpClients;
    var HttpPost = Packages.org.apache.http.client.methods.HttpPost;
    var StringEntity = Packages.org.apache.http.entity.StringEntity;
    var EntityUtils = Packages.org.apache.http.util.EntityUtils;

    var client = HttpClients.createDefault();
    var request = new HttpPost(url);

    if (headers) {
        for (var key in headers) request.addHeader(key, headers[key]);
    }
    request.setEntity(new StringEntity(body, 'UTF-8'));

    var response = null;
    try {
        response = client.execute(request);
        return {
            status: response.getStatusLine().getStatusCode(),
            body: EntityUtils.toString(response.getEntity(), 'UTF-8')
        };
    } finally {
        if (response != null) response.close();
        client.close();
    }
}
```

## Production Considerations

- **Cache the HttpClient** if you're calling the same endpoint many times — `HttpClients.createDefault()` instantiates a fresh connection pool every call. For high-throughput channels, instantiate once in the channel `deployScript` and store in `globalChannelMap`.
- **Add timeouts**: `RequestConfig.custom().setConnectTimeout(5000).setSocketTimeout(8000).build()`. Default timeouts can hang a channel during an outage.
- **Wrap in try/catch**: TX server outages should fail open (log + use local mapping table fallback) not block the message.
- **Don't use it for high-volume terminology lookups**: 100K msgs/day × 200ms TX latency = ~5.5 hours of cumulative wait. Cache validated codes in `globalChannelMap` or a Redis sidecar.

## Why Not `java.net.URL`?

Documented in [GitHub #6254](https://github.com/nextgenhealthcare/connect/issues/6254). The Rhino script engine resolves `new java.net.URL(...).openConnection()` to the internal `sun.net.www.protocol.http.HttpURLConnection` class, which Java 17's module system blocks. There is no workaround at the JVM-flag level that fully resolves it.

Apache HttpClient sidesteps this entirely because it's a pure-API library — no internal `sun.*` access.

## Why Not slf4j-api in custom-lib?

If you copy `slf4j-api-*.jar` into `custom-lib/`, Mirth's `ChildFirstURLClassLoader` will load it ahead of Mirth's internal `slf4j-api-1.7.30.jar` from `server-lib/donkey/`. Any class that statically links `org.slf4j.LoggerFactory` will then fail with:

```
java.lang.LinkageError: loader constraint violation: when resolving method
'org.slf4j.ILoggerFactory org.slf4j.impl.StaticLoggerBinder.getLoggerFactory()'
the class loader com.mirth.connect.server.util.ChildFirstURLClassLoader
of the current class, org/slf4j/LoggerFactory, and the class loader
java.net.URLClassLoader for the method's defining class
have different Class objects for the type org/slf4j/ILoggerFactory
```

Apache HttpClient depends on SLF4J transitively. Don't worry — Mirth's bundled SLF4J satisfies it. Just leave `slf4j-api` out of `custom-lib/`.

This is the root cause of why the Kafka *consumer* doesn't work from `JavaScript Reader` but the *producer* does work from transformers — different classloader scopes.
