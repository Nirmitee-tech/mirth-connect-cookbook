#!/usr/bin/env python3
"""
Mock downstream API for local testing of the fan-out channel.

Acts like a patient-portal or notification-service endpoint that the
HTTP destination POSTs lab results to. Returns a stable ack envelope
so the response handler has something to parse.

Run:
    python3 mock-api-server.py
    # listens on :8089 (override with PORT env var)

Point the channel's HTTP Sender at:
    http://host.docker.internal:8089/api/lab-results
"""
import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler


class MockAPI(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8", errors="replace")

        try:
            parsed = json.loads(body)
            event_id = parsed.get("eventId", "unknown")
        except json.JSONDecodeError:
            event_id = "unparseable"

        ack = {
            "id":         f"ack-{int(time.time()*1000)}",
            "eventId":    event_id,
            "status":     "received",
            "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        payload = json.dumps(ack).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
        print(f"[mock-api] POST {self.path} eventId={event_id} -> ack id={ack['id']}")

    def log_message(self, fmt, *args):
        pass  # suppress default access logs; we print our own line per POST


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8089"))
    print(f"Mock API server listening on :{port}")
    HTTPServer(("0.0.0.0", port), MockAPI).serve_forever()
