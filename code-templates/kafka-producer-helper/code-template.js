/**
 * Kafka Producer Helper for Mirth Connect (Java 17 Compatible)
 *
 * Reusable KafkaProducer factory + send helpers usable from Mirth transformers.
 *
 * REQUIREMENTS:
 *   1. Copy these JARs to /opt/connect/custom-lib/:
 *        - kafka-clients-3.7.0.jar
 *        - lz4-java-1.8.0.jar
 *        - snappy-java-1.1.10.5.jar
 *        - zstd-jni-1.5.5-6.jar
 *   2. DO NOT include slf4j-api JAR (classloader conflict — see apache-http-client/README.md)
 *   3. Set server.includecustomlib = true
 *   4. Restart Mirth
 *
 * KNOWN LIMITATION: Kafka CONSUMER does NOT work from JavaScript Reader source connectors
 * due to SLF4J classloader conflict. Use the Python bridge script in scripts/testing/
 * for consumption. PRODUCER works fine from transformers.
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13, Kafka 3.7.0
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var Properties = Packages.java.util.Properties;
var KafkaProducer = Packages.org.apache.kafka.clients.producer.KafkaProducer;
var ProducerRecord = Packages.org.apache.kafka.clients.producer.ProducerRecord;

/**
 * Create a configured KafkaProducer. Cache the result in globalChannelMap
 * if you want to reuse across messages in the same channel.
 *
 * @param {string} bootstrapServers - "host1:9092,host2:9092"
 * @param {object} extraProps - additional Kafka producer properties
 */
function createKafkaProducer(bootstrapServers, extraProps) {
    var props = new Properties();
    props.put('bootstrap.servers', bootstrapServers);
    props.put('key.serializer', 'org.apache.kafka.common.serialization.StringSerializer');
    props.put('value.serializer', 'org.apache.kafka.common.serialization.StringSerializer');
    props.put('acks', 'all');
    props.put('retries', '3');
    props.put('linger.ms', '5');
    props.put('compression.type', 'snappy');

    if (extraProps) {
        for (var key in extraProps) {
            props.put(key, extraProps[key].toString());
        }
    }

    return new KafkaProducer(props);
}

/**
 * Synchronously publish a message to a Kafka topic.
 * @returns {{topic: string, partition: number, offset: number}}
 */
function publishToKafka(producer, topic, key, value) {
    var record = new ProducerRecord(topic, key + '', value + '');
    var future = producer.send(record);
    var metadata = future.get();

    return {
        topic: metadata.topic() + '',
        partition: parseInt(metadata.partition()),
        offset: parseInt(metadata.offset())
    };
}

/**
 * Asynchronously publish (fire-and-forget with callback for logging).
 * Use for high-throughput channels where you can tolerate at-least-once.
 */
function publishToKafkaAsync(producer, topic, key, value, callback) {
    var record = new ProducerRecord(topic, key + '', value + '');
    var Callback = Packages.org.apache.kafka.clients.producer.Callback;
    var cb = new Callback({
        onCompletion: function(metadata, exception) {
            if (callback) callback(metadata, exception);
        }
    });
    producer.send(record, cb);
}

/**
 * Closes producer and flushes buffered messages.
 * Call this in channel undeployScript.
 */
function closeKafkaProducer(producer) {
    if (producer) {
        producer.flush();
        producer.close();
    }
}

/**
 * Example usage in a Mirth source transformer:
 *
 *   var producer = createKafkaProducer('kafka:9092');
 *   try {
 *       var bundle = channelMap.get('fhirBundle');
 *       var patientId = channelMap.get('patientId');
 *       var result = publishToKafka(producer, 'adt-fhir-bundles', patientId, bundle);
 *       logger.info('Published to ' + result.topic + ' partition=' + result.partition + ' offset=' + result.offset);
 *   } finally {
 *       closeKafkaProducer(producer);
 *   }
 *
 * For high-throughput channels, cache the producer in globalChannelMap:
 *
 *   // In deployScript:
 *   globalChannelMap.put('kafkaProducer', createKafkaProducer('kafka:9092'));
 *
 *   // In transformer:
 *   var producer = globalChannelMap.get('kafkaProducer');
 *   publishToKafka(producer, 'topic', key, value);
 *
 *   // In undeployScript:
 *   closeKafkaProducer(globalChannelMap.get('kafkaProducer'));
 */
