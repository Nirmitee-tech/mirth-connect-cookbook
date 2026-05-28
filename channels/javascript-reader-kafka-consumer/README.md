# JavaScript Reader → Kafka Consumer (Classloader Limitation)

**This recipe documents a known limitation in Mirth Connect 4.5.2:** the Kafka *consumer* fails to load from a JavaScript Reader source connector even though the *producer* works fine from transformers and destinations. We explain the root cause, show the exact error, and provide a production-ready Python bridge as the recommended alternative.

If you don't read past this paragraph, take this away: **use [`scripts/testing/kafka-bridge.py`](../../scripts/testing/kafka-bridge.py) + an HTTP Listener source** instead of a JavaScript Reader consumer. It's smaller, more reliable, and you can scale it horizontally.

## The two-line summary

- ✅ **Kafka producer** from a Mirth transformer / destination: works. Use [channels/kafka-producer/](../kafka-producer/).
- ❌ **Kafka consumer** from a Mirth JavaScript Reader: fails with SLF4J classloader conflict on stock Mirth 4.5.2.
- ✅ **Python bridge → Mirth HTTP Listener**: works, scales, and is the recommended pattern.

## Why the producer works but the consumer doesn't

Mirth loads each channel script in its own `ChildFirstURLClassLoader`. SLF4J's `StaticLoggerBinder` lives in the parent (Mirth-wide) loader because Mirth itself uses log4j2 as its logging backend.

- **Producer** (`KafkaProducer.send(...)`) is invoked synchronously from a single Mirth thread that does NOT spawn long-lived background threads under the channel's classloader. SLF4J calls happen, but they resolve in the same scope every time.
- **Consumer** (`KafkaConsumer.poll(...)`) spins up a *consumer coordinator* thread + a *heartbeat* thread. Those threads inherit a different effective classloader context for SLF4J's `LoggerFactory.getLogger()` lookup, and the JVM enforces a **loader-constraint** check across the two. The check fails because the parent loader and the child loader hold different `StaticLoggerBinder` classes.

The exact error varies by JAR version. We've reproduced these three on Mirth 4.5.2 + `kafka-clients-3.6.0.jar`:

```
java.lang.LinkageError: loader constraint violation: when resolving method
'org.slf4j.spi.LoggerFactoryBinder.getLoggerFactoryClassStr()' the class
loader (instance of com/mirth/connect/server/userutil/MirthClassLoader)
of the current class, org/apache/kafka/clients/consumer/KafkaConsumer,
and the class loader (instance of org/eclipse/jetty/webapp/WebAppClassLoader)
for the method's defining class, org/slf4j/LoggerFactory, have different
Class objects for the type org/slf4j/spi/LoggerFactoryBinder
```

```
java.lang.NoClassDefFoundError: Could not initialize class
org.apache.kafka.clients.consumer.internals.ConsumerCoordinator
```

```
org.slf4j.LoggerFactory$NOPLoggerFactory cannot be cast to
ch.qos.logback.classic.LoggerContext
```

All three trace back to the same root cause.

## What the consumer code would look like

If you have customised Mirth's classpath (`custom-lib/` + JVM flag `-Dmirth.classloader.parentFirst=true` so SLF4J is unified), the consumer template in [reader.js](reader.js) is complete and ready. We make **no guarantees** about behaviour outside of that override.

The script:

1. Builds a `Properties` object with consumer config.
2. Constructs a `KafkaConsumer` (this is the line that throws on stock Mirth).
3. Subscribes to the configured topic.
4. Polls for up to `MAX_RECORDS` messages.
5. Materializes each `ConsumerRecord` to a `LinkedHashMap` for Mirth to emit as a message.
6. Synchronously commits offsets only after the batch is built.
7. On error, logs to `globalChannelMap['kafka.consumer.lastError']` so monitoring can pick it up, and prints the recommended fallback.

## The recommended alternative: Python bridge → HTTP Listener

```
   ┌───────┐         ┌──────────────────────┐         ┌─────────────────┐
   │ Kafka │ ──poll──► kafka-bridge.py      │ ──POST──► Mirth HTTP      │
   │ topic │         │ (kafka-python +      │         │ Listener source │
   └───────┘         │  requests)           │         │ port 8090       │
                     └──────────────────────┘         └─────────────────┘
```

[`scripts/testing/kafka-bridge.py`](../../scripts/testing/kafka-bridge.py) is the production-quality version. Run it as a systemd service / sidecar / k8s deployment. It:

- Manages its own consumer group offsets (commits **after** a successful Mirth POST).
- Translates Kafka headers into HTTP headers (so your transformer sees topic/partition/offset).
- Retries with exponential backoff if Mirth is restarting.
- Can be scaled horizontally by running multiple instances with the same `--group` — Kafka rebalances partitions across them.

Channel-side configuration:

1. **Channel → Source → HTTP Listener** on port 8090, base path `/kafka`.
2. **Source transformer**: parse `msg` as the Kafka record value; read `sourceMap.get('headers')` for topic/partition/offset/key.
3. Deploy normally — everything downstream is identical to a "real" Kafka consumer.

Start the bridge:

```bash
python3 scripts/testing/kafka-bridge.py \
    --topic adt-fhir-bundles \
    --bootstrap localhost:9092 \
    --mirth-url http://localhost:8090/kafka \
    --group mirth-bridge
```

## Where to install (if you insist on the JS Reader)

1. **Channel → Source → Connector type:** JavaScript Reader
2. Paste [reader.js](reader.js) into the script field.
3. **Polling type:** Interval — 10000 ms (10s).
4. **Settings → Configuration Map:**

   | Key | Default | Purpose |
   |---|---|---|
   | `kafka.bootstrap.servers` | `localhost:9092` | Comma-separated brokers |
   | `kafka.topic` | `adt-fhir-bundles` | Topic to consume |
   | `kafka.group.id` | `mirth-consumer` | Consumer group |
   | `kafka.poll.ms` | `5000` | `KafkaConsumer.poll()` timeout |
   | `kafka.max.records` | `100` | Max records per poll cycle |

5. Put `kafka-clients-3.x.x.jar` (and `lz4-java`, `snappy-java`, `zstd-jni` if you use compression) in `custom-lib/`.
6. Add `-Dmirth.classloader.parentFirst=true` to Mirth's JVM args in `mcserver.vmoptions`.
7. Restart Mirth.
8. Cross your fingers and watch the channel log.

## Test

**Verifying the failure on stock Mirth** (this is the recipe's main value — proving the limitation is real):

```bash
# 1. Spin up Kafka
docker compose up -d kafka

# 2. Create the topic
docker exec mirth-kafka kafka-topics --create --topic adt-fhir-bundles \
    --bootstrap-server localhost:9092 --partitions 3 --replication-factor 1

# 3. Deploy the channel with the script as-is (no classpath override).

# 4. Watch the Mirth server log
tail -f /opt/mirth/logs/mirth.log | grep -E '(Kafka|SLF4J|LinkageError)'

# Expected output within ~10s of deploy:
#   ⚠️  Kafka consumer in JavaScript Reader: known classloader limitation. See README. Attempting anyway...
#   Kafka consumer FAILED (classloader limitation expected): java.lang.LinkageError: loader constraint violation...
#   → Switch to scripts/testing/kafka-bridge.py + HTTP Listener source. See README.
```

**Verifying the Python bridge works**:

```bash
# 1. Deploy an HTTP Listener channel on port 8090 path /kafka.
# 2. Start the bridge:
python3 scripts/testing/kafka-bridge.py --topic adt-fhir-bundles \
    --bootstrap localhost:9092 --mirth-url http://localhost:8090/kafka

# 3. Produce a test message:
docker exec -i mirth-kafka kafka-console-producer --topic adt-fhir-bundles \
    --bootstrap-server localhost:9092 <<<'{"hello":"mirth"}'

# 4. Channel dashboard should show 1 message received.
```

## Customize

- **SASL/SSL Kafka**: add `security.protocol`, `sasl.mechanism`, `sasl.jaas.config` to the Properties block. For the Python bridge, use `--sasl-mechanism PLAIN --username ... --password ...` (see kafka-bridge.py `--help`).
- **Schema Registry / Avro**: deserialize in the bridge (using `confluent-kafka[avro]`), POST JSON to Mirth. Don't deserialize Avro inside Mirth — same classpath problem.
- **At-least-once vs exactly-once**: the bridge commits AFTER Mirth's `2xx`. To get exactly-once, add an idempotency key to the HTTP POST (e.g. `<topic>-<partition>-<offset>`) and dedup inside Mirth using a `globalChannelMap` LRU.

## Production considerations

- **Don't fight the JVM**: the classloader override has cured the symptom for us in dev, but a Mirth upgrade can silently break it again. The Python bridge is the durable solution.
- **Bridge HA**: run two bridge processes with the same `--group`; Kafka will rebalance partitions across them. Lag is observable via `kafka-consumer-groups --describe --group mirth-bridge`.
- **Backpressure**: when Mirth is slow, the bridge should slow down too. Default `kafka-python` behaviour is fine; tune `--poll-timeout` and `--max-records` if you see consumer lag.
- **Observability**: emit consumer lag to your metrics backend. The bridge can expose `/metrics` (Prometheus format) — pair with [code-templates/prometheus-metrics-exporter](../prometheus-metrics-exporter/).

## Files

- [reader.js](reader.js) — the JavaScript Reader script (with the classloader caveat documented inline)
- [`scripts/testing/kafka-bridge.py`](../../scripts/testing/kafka-bridge.py) — the recommended Python bridge

## See also

- [channels/kafka-producer/](../kafka-producer/) — the producer-side recipe, which **does** work from a Mirth transformer
- [code-templates/kafka-producer-helper/](../../code-templates/kafka-producer-helper/) — reusable producer helper
