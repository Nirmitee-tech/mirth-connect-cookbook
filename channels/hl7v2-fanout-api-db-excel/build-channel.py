#!/usr/bin/env python3
"""
Build the deployable fan-out channel XML.

We start from an existing, known-working channel exported from a running
Mirth Connect (the demo's HL7v2 ADT to FHIR Bundle) and surgically modify
it to become a 3-destination fan-out channel. This is more robust than
generating Mirth XStream XML from scratch — Mirth's deserializer is
strict about field ordering and version markers that aren't documented.

Steps:
  1. Pull the template channel from a running Mirth (or from disk if
     --template is passed)
  2. Replace id, name, description, port
  3. Swap source-transformer body
  4. Replace the single destination with 3 destinations:
       - HTTP Sender to AI endpoint  (Destination 1)
       - Database Writer to Postgres (Destination 2)
       - File Writer to CSV          (Destination 3)
  5. Write to channel.xml

Run:
    python3 build-channel.py > channel.xml
"""
import argparse
import os
import re
import sys
import uuid
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

HERE = Path(__file__).parent
TEMPLATE_CHANNEL_NAME = "HL7v2 ADT to FHIR Bundle"


def fetch_template(mirth_url, user, password):
    """Pull the template channel XML from a running Mirth."""
    s = requests.Session()
    s.verify = False
    s.headers.update({"X-Requested-With": "OpenAPI"})
    s.post(f"{mirth_url}/api/users/_login",
           data={"username": user, "password": password},
           timeout=10).raise_for_status()
    r = s.get(f"{mirth_url}/api/channels",
              headers={"Accept": "application/xml"}, timeout=15)
    r.raise_for_status()
    pattern = re.compile(
        rf'(<channel version="[^"]+">.*?<name>{re.escape(TEMPLATE_CHANNEL_NAME)}</name>.*?</channel>)',
        re.DOTALL,
    )
    m = pattern.search(r.text)
    if not m:
        sys.exit(
            f"Could not find template channel '{TEMPLATE_CHANNEL_NAME}' in Mirth.\n"
            "The demo's ADT-to-FHIR channel is used as a structural template. "
            "Run the parent mirth-demo stack first, or pass --template path/to/known-good-channel.xml."
        )
    return m.group(1)


def replace_source_transformer(xml, new_script):
    """Replace the entire <transformer><elements>...</elements></transformer>
    block on the source connector with one JavaScriptStep running new_script."""
    # XML-escape the script body — matches Mirth's own export format
    escaped = (new_script.replace("&", "&amp;")
               .replace("<", "&lt;")
               .replace(">", "&gt;"))
    step = (
        "          <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version=\"4.5.2\">\n"
        "            <name>Parse ORU and stash fields</name>\n"
        "            <sequenceNumber>0</sequenceNumber>\n"
        "            <enabled>true</enabled>\n"
        f"            <script>{escaped}</script>\n"
        "          </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>"
    )
    # Replace the first <transformer ...><elements>...</elements>... block
    # (which belongs to the source connector — it appears before <destinationConnectors>)
    dest_start = xml.find("<destinationConnectors>")
    head = xml[:dest_start]
    tail = xml[dest_start:]
    head = re.sub(
        r"<elements>.*?</elements>",
        f"<elements>\n{step}\n        </elements>",
        head,
        count=1,
        flags=re.DOTALL,
    )
    return head + tail


def build_http_destination(metadata_id, ai_request_script, ai_response_script):
    """Build Destination 1: HTTP Sender to AI endpoint, with response transformer
    that parses the AI reply into channelMap."""
    req_escaped = (ai_request_script.replace("&", "&amp;")
                   .replace("<", "&lt;").replace(">", "&gt;"))
    res_escaped = (ai_response_script.replace("&", "&amp;")
                   .replace("<", "&lt;").replace(">", "&gt;"))
    return f"""      <connector version="4.5.2">
        <metaDataId>{metadata_id}</metaDataId>
        <name>Downstream API (HTTP)</name>
        <properties class="com.mirth.connect.connectors.http.HttpDispatcherProperties" version="4.5.2">
          <pluginProperties/>
          <destinationConnectorProperties version="4.5.2">
            <queueEnabled>true</queueEnabled>
            <sendFirst>false</sendFirst>
            <retryIntervalMillis>2000</retryIntervalMillis>
            <regenerateTemplate>false</regenerateTemplate>
            <retryCount>1</retryCount>
            <rotate>false</rotate>
            <includeFilterTransformer>false</includeFilterTransformer>
            <threadCount>4</threadCount>
            <threadAssignmentVariable/>
            <validateResponse>false</validateResponse>
            <resourceIds class="linked-hash-map">
              <entry><string>Default Resource</string><string>[Default Resource]</string></entry>
            </resourceIds>
            <queueBufferSize>1000</queueBufferSize>
            <reattachAttachments>true</reattachAttachments>
          </destinationConnectorProperties>
          <host>http://host.docker.internal:8089/api/lab-results</host>
          <method>post</method>
          <headers class="linked-hash-map">
            <entry><string>Content-Type</string><list><string>application/json</string></list></entry>
          </headers>
          <parameters class="linked-hash-map"/>
          <responseXmlBody>false</responseXmlBody>
          <responseParseMultipart>true</responseParseMultipart>
          <responseIncludeMetadata>false</responseIncludeMetadata>
          <responseBinaryMimeTypes>application/.*(?&lt;!json|xml)$|image/.*|video/.*|audio/.*</responseBinaryMimeTypes>
          <responseBinaryMimeTypesRegex>true</responseBinaryMimeTypesRegex>
          <multipart>false</multipart>
          <useAuthentication>false</useAuthentication>
          <authenticationType>Basic</authenticationType>
          <usePreemptiveAuthentication>false</usePreemptiveAuthentication>
          <username/>
          <password/>
          <content>${{message.encodedData}}</content>
          <contentType>application/json</contentType>
          <dataTypeBinary>false</dataTypeBinary>
          <charset>UTF-8</charset>
          <socketTimeout>15000</socketTimeout>
        </properties>
        <transformer version="4.5.2">
          <elements>
            <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
              <name>Build API payload</name>
              <sequenceNumber>0</sequenceNumber>
              <enabled>true</enabled>
              <script>{req_escaped}</script>
            </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
          </elements>
          <inboundDataType>HL7V2</inboundDataType>
          <outboundDataType>RAW</outboundDataType>
          <inboundProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties" version="4.5.2">
            <serializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2SerializationProperties" version="4.5.2">
              <handleRepetitions>true</handleRepetitions>
              <handleSubcomponents>true</handleSubcomponents>
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <stripNamespaces>false</stripNamespaces>
              <segmentDelimiter>\\r</segmentDelimiter>
              <convertLineBreaks>true</convertLineBreaks>
            </serializationProperties>
            <deserializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DeserializationProperties" version="4.5.2">
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <segmentDelimiter>\\r</segmentDelimiter>
            </deserializationProperties>
          </inboundProperties>
          <outboundProperties class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="4.5.2"/>
        </transformer>
        <responseTransformer version="4.5.2">
          <elements>
            <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
              <name>Handle API response</name>
              <sequenceNumber>0</sequenceNumber>
              <enabled>true</enabled>
              <script>{res_escaped}</script>
            </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
          </elements>
          <inboundDataType>RAW</inboundDataType>
          <outboundDataType>RAW</outboundDataType>
          <inboundProperties class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="4.5.2"/>
          <outboundProperties class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="4.5.2"/>
        </responseTransformer>
        <filter version="4.5.2"><elements/></filter>
        <transportName>HTTP Sender</transportName>
        <mode>DESTINATION</mode>
        <enabled>true</enabled>
        <waitForPrevious>true</waitForPrevious>
      </connector>"""


def build_db_destination(metadata_id, db_script):
    db_escaped = (db_script.replace("&", "&amp;")
                  .replace("<", "&lt;").replace(">", "&gt;"))
    return f"""      <connector version="4.5.2">
        <metaDataId>{metadata_id}</metaDataId>
        <name>DB Write (Postgres)</name>
        <properties class="com.mirth.connect.connectors.jdbc.DatabaseDispatcherProperties" version="4.5.2">
          <pluginProperties/>
          <destinationConnectorProperties version="4.5.2">
            <queueEnabled>true</queueEnabled>
            <sendFirst>false</sendFirst>
            <retryIntervalMillis>5000</retryIntervalMillis>
            <regenerateTemplate>false</regenerateTemplate>
            <retryCount>3</retryCount>
            <rotate>false</rotate>
            <includeFilterTransformer>false</includeFilterTransformer>
            <threadCount>4</threadCount>
            <threadAssignmentVariable/>
            <validateResponse>false</validateResponse>
            <resourceIds class="linked-hash-map">
              <entry><string>Default Resource</string><string>[Default Resource]</string></entry>
            </resourceIds>
            <queueBufferSize>1000</queueBufferSize>
            <reattachAttachments>true</reattachAttachments>
          </destinationConnectorProperties>
          <driver>org.postgresql.Driver</driver>
          <url>jdbc:postgresql://mirth-db:5432/mirthdb</url>
          <username>mirthdb</username>
          <password>mirthdb</password>
          <query>INSERT INTO lab_results (message_id, mrn, patient_name, dob, sex, order_id, test_code, test_name, ordered_at, ordering_md, has_abnormal, observations, api_ack_id, api_status, received_at) VALUES (${{message_id}}, ${{mrn}}, ${{patient_name}}, ${{dob}}, ${{sex}}, ${{order_id}}, ${{test_code}}, ${{test_name}}, ${{ordered_at}}, ${{ordering_md}}, ${{has_abnormal}}, ${{observations}}::jsonb, ${{api_ack_id}}, ${{api_status}}, NOW()) ON CONFLICT (message_id) DO NOTHING</query>
          <useScript>false</useScript>
        </properties>
        <transformer version="4.5.2">
          <elements>
            <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
              <name>Build DB parameter map</name>
              <sequenceNumber>0</sequenceNumber>
              <enabled>true</enabled>
              <script>{db_escaped}</script>
            </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
          </elements>
          <inboundDataType>HL7V2</inboundDataType>
          <outboundDataType>RAW</outboundDataType>
          <inboundProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties" version="4.5.2">
            <serializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2SerializationProperties" version="4.5.2">
              <handleRepetitions>true</handleRepetitions>
              <handleSubcomponents>true</handleSubcomponents>
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <stripNamespaces>false</stripNamespaces>
              <segmentDelimiter>\\r</segmentDelimiter>
              <convertLineBreaks>true</convertLineBreaks>
            </serializationProperties>
            <deserializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DeserializationProperties" version="4.5.2">
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <segmentDelimiter>\\r</segmentDelimiter>
            </deserializationProperties>
          </inboundProperties>
          <outboundProperties class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="4.5.2"/>
        </transformer>
        <filter version="4.5.2"><elements/></filter>
        <transportName>Database Writer</transportName>
        <mode>DESTINATION</mode>
        <enabled>true</enabled>
        <waitForPrevious>false</waitForPrevious>
      </connector>"""


def build_file_destination(metadata_id, csv_script):
    csv_escaped = (csv_script.replace("&", "&amp;")
                   .replace("<", "&lt;").replace(">", "&gt;"))
    return f"""      <connector version="4.5.2">
        <metaDataId>{metadata_id}</metaDataId>
        <name>Excel CSV Append</name>
        <properties class="com.mirth.connect.connectors.file.FileDispatcherProperties" version="4.5.2">
          <pluginProperties/>
          <destinationConnectorProperties version="4.5.2">
            <queueEnabled>true</queueEnabled>
            <sendFirst>false</sendFirst>
            <retryIntervalMillis>2000</retryIntervalMillis>
            <regenerateTemplate>false</regenerateTemplate>
            <retryCount>1</retryCount>
            <rotate>false</rotate>
            <includeFilterTransformer>false</includeFilterTransformer>
            <threadCount>1</threadCount>
            <threadAssignmentVariable/>
            <validateResponse>false</validateResponse>
            <resourceIds class="linked-hash-map">
              <entry><string>Default Resource</string><string>[Default Resource]</string></entry>
            </resourceIds>
            <queueBufferSize>1000</queueBufferSize>
            <reattachAttachments>true</reattachAttachments>
          </destinationConnectorProperties>
          <scheme>file</scheme>
          <schemeProperties class="com.mirth.connect.connectors.file.SchemeProperties"/>
          <host>/opt/connect/appdata</host>
          <outputPattern>lab-results.csv</outputPattern>
          <anonymous>true</anonymous>
          <username/>
          <password/>
          <timeout>10000</timeout>
          <keepConnectionOpen>true</keepConnectionOpen>
          <maxIdleTime>0</maxIdleTime>
          <secure>false</secure>
          <passive>true</passive>
          <validateConnection>true</validateConnection>
          <outputAppend>true</outputAppend>
          <errorOnExists>false</errorOnExists>
          <temporary>false</temporary>
          <binary>false</binary>
          <charsetEncoding>UTF-8</charsetEncoding>
          <template>${{message.encodedData}}</template>
        </properties>
        <transformer version="4.5.2">
          <elements>
            <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
              <name>Format CSV row</name>
              <sequenceNumber>0</sequenceNumber>
              <enabled>true</enabled>
              <script>{csv_escaped}</script>
            </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
          </elements>
          <inboundDataType>HL7V2</inboundDataType>
          <outboundDataType>RAW</outboundDataType>
          <inboundProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties" version="4.5.2">
            <serializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2SerializationProperties" version="4.5.2">
              <handleRepetitions>true</handleRepetitions>
              <handleSubcomponents>true</handleSubcomponents>
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <stripNamespaces>false</stripNamespaces>
              <segmentDelimiter>\\r</segmentDelimiter>
              <convertLineBreaks>true</convertLineBreaks>
            </serializationProperties>
            <deserializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DeserializationProperties" version="4.5.2">
              <useStrictParser>false</useStrictParser>
              <useStrictValidation>false</useStrictValidation>
              <segmentDelimiter>\\r</segmentDelimiter>
            </deserializationProperties>
          </inboundProperties>
          <outboundProperties class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="4.5.2"/>
        </transformer>
        <filter version="4.5.2"><elements/></filter>
        <transportName>File Writer</transportName>
        <mode>DESTINATION</mode>
        <enabled>true</enabled>
        <waitForPrevious>false</waitForPrevious>
      </connector>"""


def main():
    parser = argparse.ArgumentParser(description="Build the fan-out channel XML")
    parser.add_argument("--mirth-url", default=os.environ.get("MIRTH_URL", "https://localhost:8443"))
    parser.add_argument("--user", default=os.environ.get("MIRTH_USER", "admin"))
    parser.add_argument("--password", default=os.environ.get("MIRTH_PASS", "admin"))
    parser.add_argument("--template", help="Path to a known-good template channel.xml (alternative to fetching from Mirth)")
    parser.add_argument("--port", type=int, default=6680, help="MLLP port for the source listener")
    args = parser.parse_args()

    # Load template
    if args.template:
        xml = Path(args.template).read_text()
    else:
        xml = fetch_template(args.mirth_url, args.user, args.password)

    # Load JS bodies
    src = (HERE / "transformers" / "source-transformer.js").read_text()
    d1_req = (HERE / "transformers" / "dest1-api-payload.js").read_text()
    d1_res = (HERE / "transformers" / "dest1-api-response.js").read_text()
    d2 = (HERE / "transformers" / "dest2-db-write.js").read_text()
    d3 = (HERE / "transformers" / "dest3-excel-row.js").read_text()

    # 1. New channel ID (deterministic so re-runs produce the same channel)
    new_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, "fanout.cookbook.nirmitee.io"))
    xml = re.sub(r"<id>[^<]+</id>", f"<id>{new_id}</id>", xml, count=1)

    # 2. Name + description (only first occurrence — at the channel top)
    xml = re.sub(r"<name>HL7v2 ADT to FHIR Bundle</name>",
                 "<name>HL7v2 ORU Fan-Out (AI + DB + Excel)</name>", xml, count=1)
    xml = re.sub(
        r"<description>[^<]*</description>",
        "<description>Receives HL7v2 ORU^R01 lab results and fans out to AI summarizer (HTTP), Postgres lab_results table (DB), and Excel-friendly CSV file. Each destination runs independently with its own queue and retry policy.</description>",
        xml, count=1,
    )

    # 3. Source port — only on the first listenerConnectorProperties block
    xml = re.sub(r"<port>6661</port>", f"<port>{args.port}</port>", xml, count=1)

    # 4. nextMetaDataId for 3 destinations (we use ids 1, 2, 3 → next is 4)
    xml = re.sub(r"<nextMetaDataId>\d+</nextMetaDataId>",
                 "<nextMetaDataId>4</nextMetaDataId>", xml, count=1)

    # 5. Swap source transformer body
    xml = replace_source_transformer(xml, src)

    # 6. Replace the entire <destinationConnectors>...</destinationConnectors>
    # block with our three destinations.
    new_dest = (
        "    <destinationConnectors>\n"
        + build_http_destination(1, d1_req, d1_res) + "\n"
        + build_db_destination(2, d2) + "\n"
        + build_file_destination(3, d3) + "\n"
        + "    </destinationConnectors>"
    )
    xml = re.sub(
        r"<destinationConnectors>.*?</destinationConnectors>",
        new_dest,
        xml,
        count=1,
        flags=re.DOTALL,
    )

    print(xml)


if __name__ == "__main__":
    main()
