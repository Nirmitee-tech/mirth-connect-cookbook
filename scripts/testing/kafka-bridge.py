#!/usr/bin/env python3
"""
kafka-bridge.py — Kafka-to-Mirth bridge for the consumer-classloader workaround.

PROBLEM:
    Kafka CONSUMER from a Mirth JavaScript Reader source connector fails with
    SLF4J classloader conflict (ChildFirstURLClassLoader vs parent loader for
    org.slf4j.impl.StaticLoggerBinder). PRODUCER works fine from transformers.

SOLUTION:
    Use a tiny Python bridge that consumes from Kafka and POSTs to Mirth's
    HTTP Listener source. Mirth then processes as if it received the message
    via HTTP.

Usage:
    python3 kafka-bridge.py --topic adt-fhir-bundles \
        --bootstrap localhost:9092 \
        --mirth-url http://localhost:8082 \
        --group mirth-bridge

Requirements:
    pip install kafka-python requests

Author: Nirmitee.io | License: MIT
"""

import argparse
import json
import logging
import signal
import sys

try:
    from kafka import KafkaConsumer
    import requests
except ImportError:
    print("Install dependencies: pip install kafka-python requests")
    sys.exit(1)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("kafka-bridge")


def run_bridge(topic: str, bootstrap: str, mirth_url: str, group: str,
               from_beginning: bool = False) -> None:
    """Consume from Kafka topic and POST each message to Mirth HTTP Listener."""

    consumer = KafkaConsumer(
        topic,
        bootstrap_servers=bootstrap,
        group_id=group,
        auto_offset_reset="earliest" if from_beginning else "latest",
        enable_auto_commit=True,
        value_deserializer=lambda m: m.decode("utf-8"),
    )

    log.info(f"Connected. Topic: {topic}, Group: {group}, Mirth: {mirth_url}")
    log.info("Waiting for messages... (Ctrl-C to stop)")

    count = 0
    failed = 0

    def shutdown(signum, frame):
        log.info(f"\nShutting down. Processed: {count}, Failed: {failed}")
        consumer.close()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    for record in consumer:
        try:
            count += 1
            body = record.value

            # Optional: parse FHIR Bundle to extract metadata for logging
            try:
                bundle = json.loads(body)
                patient = "unknown"
                for entry in bundle.get("entry", []):
                    if entry["resource"].get("resourceType") == "Patient":
                        name = entry["resource"]["name"][0]
                        patient = f"{name.get('given', ['?'])[0]} {name.get('family', '?')}"
                        break
                log.info(
                    f"[{count}] {topic} partition={record.partition} "
                    f"offset={record.offset} patient={patient}"
                )
            except (json.JSONDecodeError, KeyError, IndexError):
                log.info(f"[{count}] {topic} partition={record.partition} offset={record.offset}")

            # POST to Mirth HTTP Listener
            response = requests.post(
                mirth_url,
                data=body,
                headers={"Content-Type": "application/fhir+json"},
                timeout=10,
            )

            if response.status_code >= 400:
                failed += 1
                log.error(
                    f"  Mirth POST failed: HTTP {response.status_code} — {response.text[:200]}"
                )

        except requests.exceptions.RequestException as e:
            failed += 1
            log.error(f"  Mirth POST exception: {e}")
        except Exception as e:
            failed += 1
            log.error(f"  Bridge error: {e}")


def main():
    parser = argparse.ArgumentParser(
        description="Kafka → Mirth HTTP Listener bridge (workaround for consumer classloader)"
    )
    parser.add_argument("--topic", required=True, help="Kafka topic name")
    parser.add_argument(
        "--bootstrap", default="localhost:9092", help="Kafka bootstrap servers"
    )
    parser.add_argument(
        "--mirth-url",
        default="http://localhost:8082",
        help="Mirth HTTP Listener URL",
    )
    parser.add_argument(
        "--group", default="mirth-bridge", help="Kafka consumer group ID"
    )
    parser.add_argument(
        "--from-beginning",
        action="store_true",
        help="Read from earliest offset (default: latest)",
    )
    args = parser.parse_args()

    run_bridge(
        args.topic, args.bootstrap, args.mirth_url, args.group, args.from_beginning
    )


if __name__ == "__main__":
    main()
