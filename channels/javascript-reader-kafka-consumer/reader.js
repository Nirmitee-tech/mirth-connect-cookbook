/**
 * JavaScript Reader — Kafka Consumer (CLASSLOADER LIMITATION RECIPE)
 *
 * ⚠️  READ THE README FIRST. This script DOES NOT WORK out-of-the-box on
 *     Mirth Connect 4.5.2 with stock library configuration.
 *
 * WHY IT FAILS:
 *   Mirth loads each channel script in a ChildFirstURLClassLoader. The
 *   Kafka client (kafka-clients-3.x.jar) and its transitive deps
 *   (lz4-java, snappy-java, zstd-jni) call SLF4J's StaticLoggerBinder.
 *   The binder is loaded by Mirth's parent loader (log4j2 backend), but
 *   the Kafka client tries to resolve it through the child loader —
 *   which doesn't see it — and throws:
 *
 *     org.slf4j.LoggerFactory$NOPLoggerFactory cannot be cast to
 *     ch.qos.logback.classic.LoggerContext
 *
 *   OR, depending on JAR versions:
 *
 *     java.lang.NoClassDefFoundError: Could not initialize class
 *     org.apache.kafka.clients.consumer.KafkaConsumer
 *     ... Caused by: java.lang.LinkageError: loader constraint
 *     violation: when resolving method
 *     'org.slf4j.spi.LoggerFactoryBinder.getLoggerFactoryClassStr()'
 *
 *   The Kafka PRODUCER works because producers are short-lived per send
 *   and don't trigger the consumer's coordinator/heartbeat threads —
 *   those threads spin up new SLF4J resolutions in a different class
 *   loader scope and that's where the constraint blows up.
 *
 * WHAT TO DO INSTEAD:
 *   Use scripts/testing/kafka-bridge.py — a tiny Python process that
 *   consumes Kafka and POSTs to Mirth's HTTP Listener source. See the
 *   README in this folder for the full pattern.
 *
 * WHEN THIS SCRIPT *MIGHT* WORK:
 *   If you have customized Mirth's classpath (custom-lib + JVM flag
 *   -Dmirth.classloader.parentFirst=true) so SLF4J is unified across
 *   loaders, this code is a complete consumer template. We've seen it
 *   work on Mirth 4.5.2 with this exact JVM flag set; we make NO
 *   guarantees.
 *
 * Place in: Channel → Source → JavaScript Reader (script field).
 *
 * Tested on: Mirth Connect 4.5.2 — FAILS WITHOUT CLASSLOADER OVERRIDE.
 * Author: Nirmitee.io | License: MIT
 */

// === Configuration ===
var cfg = (typeof configurationMap !== 'undefined' && configurationMap) ? configurationMap : null;
var KAFKA_BOOTSTRAP   = (cfg && cfg.get('kafka.bootstrap.servers')) || 'localhost:9092';
var KAFKA_TOPIC       = (cfg && cfg.get('kafka.topic'))             || 'adt-fhir-bundles';
var KAFKA_GROUP       = (cfg && cfg.get('kafka.group.id'))          || 'mirth-consumer';
var POLL_TIMEOUT_MS   = parseInt((cfg && cfg.get('kafka.poll.ms')) || '5000', 10);
var MAX_RECORDS       = parseInt((cfg && cfg.get('kafka.max.records')) || '100', 10);

// =====================================================================
// THE CODE THAT FAILS (kept here so you can see exactly what to expect).
// =====================================================================

logger.warn('⚠️  Kafka consumer in JavaScript Reader: known classloader' +
    ' limitation. See README. Attempting anyway...');

var Properties = Packages.java.util.Properties;
var props = new Properties();
props.put('bootstrap.servers',         KAFKA_BOOTSTRAP);
props.put('group.id',                  KAFKA_GROUP);
props.put('enable.auto.commit',        'false');
props.put('auto.offset.reset',         'earliest');
props.put('key.deserializer',          'org.apache.kafka.common.serialization.StringDeserializer');
props.put('value.deserializer',        'org.apache.kafka.common.serialization.StringDeserializer');
props.put('max.poll.records',          '' + MAX_RECORDS);
props.put('session.timeout.ms',        '30000');

var rowsList = new Packages.java.util.ArrayList();
var consumer = null;

try {
    // ↓ THIS LINE THROWS ON STOCK MIRTH 4.5.2 ↓
    consumer = new Packages.org.apache.kafka.clients.consumer.KafkaConsumer(props);

    var topics = new Packages.java.util.ArrayList();
    topics.add(KAFKA_TOPIC);
    consumer.subscribe(topics);

    var records = consumer.poll(Packages.java.time.Duration.ofMillis(POLL_TIMEOUT_MS));
    var it = records.iterator();
    while (it.hasNext()) {
        var rec = it.next();
        var row = new Packages.java.util.LinkedHashMap();
        row.put('topic',     rec.topic());
        row.put('partition', rec.partition());
        row.put('offset',    rec.offset());
        row.put('key',       rec.key());
        row.put('value',     rec.value());
        row.put('timestamp', rec.timestamp());
        rowsList.add(row);
    }

    // Commit synchronously only after we've materialized the batch.
    // If Mirth fails to ingest, the next poll will redeliver.
    if (rowsList.size() > 0) {
        consumer.commitSync();
        logger.info('Kafka: consumed ' + rowsList.size() + ' records from ' + KAFKA_TOPIC);
    }
} catch (e) {
    // Expected on stock Mirth — log, return empty batch, surface to
    // monitoring so an operator sees the failure rather than silent zeros.
    var msg = '' + e;
    logger.error('Kafka consumer FAILED (classloader limitation expected): ' + msg);
    if (typeof globalChannelMap !== 'undefined') {
        globalChannelMap.put('kafka.consumer.lastError', msg);
        globalChannelMap.put('kafka.consumer.lastErrorAt', new Date().toISOString());
    }
    // Tell the operator to switch to the Python bridge.
    if (msg.indexOf('SLF4J') >= 0 || msg.indexOf('LoggerFactory') >= 0 ||
        msg.indexOf('NoClassDefFoundError') >= 0 || msg.indexOf('LinkageError') >= 0) {
        logger.error('→ Switch to scripts/testing/kafka-bridge.py + HTTP Listener source. See README.');
    }
} finally {
    try { if (consumer) consumer.close(); } catch (e) {}
}

rowsList;
