#!/usr/bin/env python3
"""
Provision clinical-purpose channels into the local Mirth Connect.

Clones the existing 'HL7v2 ADT to FHIR Bundle' template and creates 4 new
channels for the scenario simulator — one per clinical interface type the
hospital-operations dashboard cares about:

   port 6671  Lab Results (ORU) Listener   → classified as Results
   port 6672  Orders (ORM) Listener        → classified as Orders
   port 6673  Claims (837) Listener        → classified as Claims
   port 6674  Pharmacy (RDS) Listener      → classified as Pharmacy

The cloned channels strip out the FHIR conversion transformer so they are
clean message-counters — receive, dispatch to a no-op VM destination, done.
This keeps the simulator focused on traffic patterns instead of fighting
HL7v2 parse errors when we deliberately push malformed payloads.
"""
import re
import sys
import uuid
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MIRTH_URL = "https://localhost:8443"
USER = "admin"
PASS = "admin"

CHANNELS_TO_PROVISION = [
    ("Lab Results (ORU) Listener", 6671, "Inbound lab/radiology results — drives chart updates"),
    ("Orders (ORM) Listener",      6672, "Order entry — drives lab/rad/pharmacy fulfillment"),
    ("Claims (837) Listener",      6673, "Billing claims out to clearinghouse"),
    ("Pharmacy (RDS) Listener",    6674, "Pharmacy dispense — drives MAR updates"),
]


def session():
    s = requests.Session()
    s.verify = False
    s.headers.update({"X-Requested-With": "OpenAPI"})
    r = s.post(f"{MIRTH_URL}/api/users/_login", data={"username": USER, "password": PASS}, timeout=10)
    r.raise_for_status()
    return s


def get_existing_channels(s):
    r = s.get(f"{MIRTH_URL}/api/channels", headers={"Accept": "application/xml"}, timeout=10)
    r.raise_for_status()
    return r.text


def fetch_template(channels_xml):
    """Pull the ADT-to-FHIR channel out as our cloning template."""
    # Crude but reliable: find the <channel>...</channel> block whose <name> matches.
    pattern = re.compile(
        r'(<channel version="4\.5\.2">.*?HL7v2 ADT to FHIR Bundle.*?</channel>)',
        re.DOTALL,
    )
    m = pattern.search(channels_xml)
    if not m:
        sys.exit("Could not find template channel 'HL7v2 ADT to FHIR Bundle' in Mirth.")
    return m.group(1)


def build_variant(template, new_name, new_port, new_description):
    """Produce a new channel XML cloned from the template."""
    xml = template

    # New IDs
    new_id = str(uuid.uuid4())
    xml = re.sub(r"<id>[^<]+</id>", f"<id>{new_id}</id>", xml, count=1)

    # New name + description (only first occurrence — these live at the top)
    xml = re.sub(r"<name>HL7v2 ADT to FHIR Bundle</name>",
                 f"<name>{new_name}</name>", xml, count=1)
    xml = re.sub(r"<description>[^<]*</description>",
                 f"<description>{new_description}</description>", xml, count=1)

    # New port
    xml = re.sub(r"<port>6661</port>", f"<port>{new_port}</port>", xml, count=1)

    # Strip the source transformer body — replace 290+ lines of FHIR conversion
    # JS with an empty transformer so non-ADT inputs do not error.
    xml = re.sub(
        r"(<sourceConnector.*?<transformer version=\"4\.5\.2\">)\s*<elements>.*?</elements>",
        r"\1\n        <elements />",
        xml,
        count=1,
        flags=re.DOTALL,
    )

    return new_id, xml


def channel_exists(channels_xml, name):
    return f"<name>{name}</name>" in channels_xml


def upsert_channel(s, channel_xml, name):
    """POST or PUT — try create, fall back to update."""
    headers = {"Content-Type": "application/xml", "Accept": "application/json"}
    r = s.post(f"{MIRTH_URL}/api/channels", data=channel_xml, headers=headers, timeout=15)
    if r.status_code == 200:
        return True
    print(f"  POST returned {r.status_code}: {r.text[:200]}")
    return False


def enable_and_deploy(s, channel_id):
    """Set channel enabled in metadata + push deploy."""
    meta_xml = f"""<map>
  <entry>
    <string>{channel_id}</string>
    <com.mirth.connect.model.ChannelMetadata>
      <enabled>true</enabled>
      <lastModified>
        <time>0</time>
        <timezone>UTC</timezone>
      </lastModified>
      <pruningSettings>
        <pruneMetaDataDays>30</pruneMetaDataDays>
        <pruneContentDays>30</pruneContentDays>
        <archiveEnabled>false</archiveEnabled>
      </pruningSettings>
    </com.mirth.connect.model.ChannelMetadata>
  </entry>
</map>"""
    r = s.post(
        f"{MIRTH_URL}/api/server/channelMetadata",
        data=meta_xml,
        headers={"Content-Type": "application/xml"},
        timeout=10,
    )
    if r.status_code not in (200, 204):
        print(f"  channelMetadata returned {r.status_code}: {r.text[:200]}")


def deploy_all(s):
    r = s.post(f"{MIRTH_URL}/api/channels/_redeployAll", timeout=30)
    return r.status_code in (200, 204)


def main():
    s = session()
    existing = get_existing_channels(s)
    template = fetch_template(existing)

    print("Provisioning clinical channels...")
    created_ids = []
    for name, port, desc in CHANNELS_TO_PROVISION:
        if channel_exists(existing, name):
            print(f"  ✓ exists: {name}")
            continue
        new_id, xml = build_variant(template, name, port, desc)
        if upsert_channel(s, xml, name):
            print(f"  ✓ created: {name}  (port {port}, id {new_id[:8]}...)")
            enable_and_deploy(s, new_id)
            created_ids.append(new_id)
        else:
            print(f"  ✗ failed:  {name}")

    if created_ids:
        print(f"\nDeploying {len(created_ids)} channels...")
        if deploy_all(s):
            print("  ✓ deploy initiated")
        else:
            print("  ✗ deploy failed — check Mirth admin UI")
    else:
        print("\nNothing to deploy — all channels already provisioned.")


if __name__ == "__main__":
    main()
