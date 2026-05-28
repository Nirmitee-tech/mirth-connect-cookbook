# Required JARs for Mirth `custom-lib/`

These JARs must be in `/opt/connect/custom-lib/` for the cookbook's HTTP client and Kafka recipes to work.

**They are NOT committed to this repo** (JAR files are tracked in `.gitignore`). Run the script below to fetch them from your Mirth installation.

## Required for Apache HttpClient (httpGet/httpPost recipes)

| JAR | Source | Purpose |
|---|---|---|
| `httpclient-4.5.13.jar` | Mirth's `server-lib/commons/` | Apache HttpClient 4.x |
| `httpcore-4.4.13.jar` | Mirth's `server-lib/commons/` | Required dependency |

## Required for Kafka producer

| JAR | Source | Purpose |
|---|---|---|
| `kafka-clients-3.7.0.jar` | Apache Kafka distribution | Kafka client API |
| `lz4-java-1.8.0.jar` | Apache Kafka libs | Compression codec |
| `snappy-java-1.1.10.5.jar` | Apache Kafka libs | Compression codec |
| `zstd-jni-1.5.5-6.jar` | Apache Kafka libs | Compression codec |

## DO NOT add

- `slf4j-api-*.jar` — causes `LinkageError: loader constraint violation` because Mirth's `ChildFirstURLClassLoader` will load it ahead of Mirth's internal SLF4J. See [code-templates/apache-http-client/README.md](../../code-templates/apache-http-client/README.md) for details.

## Setup script

```bash
#!/bin/bash
# Copy required JARs to running Mirth Docker container

# From Mirth's bundled libraries
docker exec mirth-connect cp /opt/connect/server-lib/commons/httpclient-4.5.13.jar /opt/connect/custom-lib/
docker exec mirth-connect cp /opt/connect/server-lib/commons/httpcore-4.4.13.jar /opt/connect/custom-lib/

# From Kafka container (if running Kafka recipes)
docker exec mirth-kafka cp /opt/kafka/libs/kafka-clients-3.7.0.jar /tmp/
docker exec mirth-kafka cp /opt/kafka/libs/lz4-java-1.8.0.jar /tmp/
docker exec mirth-kafka cp /opt/kafka/libs/snappy-java-1.1.10.5.jar /tmp/
docker exec mirth-kafka cp /opt/kafka/libs/zstd-jni-1.5.5-6.jar /tmp/

for jar in kafka-clients-3.7.0.jar lz4-java-1.8.0.jar snappy-java-1.1.10.5.jar zstd-jni-1.5.5-6.jar; do
    docker cp mirth-kafka:/tmp/$jar /tmp/$jar
    docker cp /tmp/$jar mirth-connect:/opt/connect/custom-lib/
done

# Enable custom-lib loading
docker exec mirth-connect sed -i 's/server.includecustomlib = false/server.includecustomlib = true/' /opt/connect/conf/mirth.properties

# Restart Mirth to pick up new JARs
docker restart mirth-connect

# Wait for ready
until curl -sk -H "X-Requested-With: OpenAPI" -H "Accept: text/plain" -u admin:admin "https://localhost:8443/api/server/version" 2>/dev/null | grep -q "4.5.2"; do sleep 2; done
echo "Mirth ready with custom-lib JARs"
```
