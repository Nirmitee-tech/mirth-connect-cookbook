#!/usr/bin/env python3
"""
build-channels.py - Emit importable Mirth channel XMLs for Epic Bridges.

Reads the inline transformer scripts (adt-inbound-transformer.js,
dft-outbound-transformer.js) and produces:
  - adt-channel.xml   (Epic ADT inbound listener -> FHIR)
  - dft-channel.xml   (DFT^P03 charges sender)

Run after editing either transformer:

    python3 build-channels.py

Tested on: Mirth Connect 4.5.2
Author: Nirmitee.io | License: MIT
"""
from __future__ import annotations

import argparse
import uuid
import xml.sax.saxutils as su
from pathlib import Path

HERE = Path(__file__).parent

HL7_INBOUND_TEMPLATE = """    <transformer version="4.5.2">
      <elements>
        <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
          <name>{step_name}</name>
          <sequenceNumber>0</sequenceNumber>
          <enabled>true</enabled>
          <script>{escaped_script}</script>
        </com.mirth.connect.plugins.javascriptstep.JavaScriptStep>
      </elements>
      <inboundTemplate encoding="base64"></inboundTemplate>
      <outboundTemplate encoding="base64"></outboundTemplate>
      <inboundDataType>HL7V2</inboundDataType>
      <outboundDataType>HL7V2</outboundDataType>
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
        <batchProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2BatchProperties" version="4.5.2">
          <splitType>MSH_Segment</splitType>
          <batchScript></batchScript>
        </batchProperties>
        <responseGenerationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseGenerationProperties" version="4.5.2">
          <segmentDelimiter>\\r</segmentDelimiter>
          <successfulACKCode>AA</successfulACKCode>
          <successfulACKMessage></successfulACKMessage>
          <errorACKCode>AE</errorACKCode>
          <errorACKMessage>An Error Occurred Processing Message.</errorACKMessage>
          <rejectedACKCode>AR</rejectedACKCode>
          <rejectedACKMessage>Message Rejected.</rejectedACKMessage>
          <msh15ACKAccept>false</msh15ACKAccept>
          <dateFormat>yyyyMMddHHmmss.SSS</dateFormat>
        </responseGenerationProperties>
        <responseValidationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseValidationProperties" version="4.5.2">
          <successfulACKCode>AA,CA</successfulACKCode>
          <errorACKCode>AE,CE</errorACKCode>
          <rejectedACKCode>AR,CR</rejectedACKCode>
          <validateMessageControlId>true</validateMessageControlId>
          <originalMessageControlId>Destination_Encoded</originalMessageControlId>
          <originalIdMapVariable></originalIdMapVariable>
        </responseValidationProperties>
      </inboundProperties>
      <outboundProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties" version="4.5.2">
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
        <batchProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2BatchProperties" version="4.5.2">
          <splitType>MSH_Segment</splitType>
          <batchScript></batchScript>
        </batchProperties>
        <responseGenerationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseGenerationProperties" version="4.5.2">
          <segmentDelimiter>\\r</segmentDelimiter>
          <successfulACKCode>AA</successfulACKCode>
          <successfulACKMessage></successfulACKMessage>
          <errorACKCode>AE</errorACKCode>
          <errorACKMessage>An Error Occurred Processing Message.</errorACKMessage>
          <rejectedACKCode>AR</rejectedACKCode>
          <rejectedACKMessage>Message Rejected.</rejectedACKMessage>
          <msh15ACKAccept>false</msh15ACKAccept>
          <dateFormat>yyyyMMddHHmmss.SSS</dateFormat>
        </responseGenerationProperties>
        <responseValidationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseValidationProperties" version="4.5.2">
          <successfulACKCode>AA,CA</successfulACKCode>
          <errorACKCode>AE,CE</errorACKCode>
          <rejectedACKCode>AR,CR</rejectedACKCode>
          <validateMessageControlId>true</validateMessageControlId>
          <originalMessageControlId>Destination_Encoded</originalMessageControlId>
          <originalIdMapVariable></originalIdMapVariable>
        </responseValidationProperties>
      </outboundProperties>
    </transformer>"""

ADT_CHANNEL_TEMPLATE = """<channel version="4.5.2">
  <id>{channel_id}</id>
  <nextMetaDataId>2</nextMetaDataId>
  <name>Epic Bridges ADT Inbound</name>
  <description>Epic Bridges -> Mirth ADT inbound. Handles A28/A31 dedup, PV1-2 patient class, custom ZPV/ZIN segments. Emits FHIR Bundle to channelMap.fhirBundle.</description>
  <revision>1</revision>
  <sourceConnector version="4.5.2">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.tcp.TcpReceiverProperties" version="4.5.2">
      <pluginProperties/>
      <listenerConnectorProperties version="4.5.2">
        <host>0.0.0.0</host>
        <port>6701</port>
      </listenerConnectorProperties>
      <sourceConnectorProperties version="4.5.2">
        <responseVariable>Auto-generate (After source transformer)</responseVariable>
        <respondAfterProcessing>true</respondAfterProcessing>
        <processBatch>false</processBatch>
        <firstResponse>true</firstResponse>
        <processingThreads>4</processingThreads>
        <resourceIds class="linked-hash-map">
          <entry>
            <string>Default Resource</string>
            <string>[Default Resource]</string>
          </entry>
        </resourceIds>
        <queueBufferSize>1000</queueBufferSize>
      </sourceConnectorProperties>
      <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
        <pluginPointName>MLLP</pluginPointName>
        <startOfMessageBytes>0B</startOfMessageBytes>
        <endOfMessageBytes>1C0D</endOfMessageBytes>
        <useMLLPv2>false</useMLLPv2>
        <ackBytes>06</ackBytes>
        <nackBytes>15</nackBytes>
        <maxRetries>2</maxRetries>
      </transmissionModeProperties>
      <serverMode>true</serverMode>
      <reconnectInterval>5000</reconnectInterval>
      <receiveTimeout>0</receiveTimeout>
      <bufferSize>65536</bufferSize>
      <maxConnections>20</maxConnections>
      <keepConnectionOpen>true</keepConnectionOpen>
      <dataTypeBinary>false</dataTypeBinary>
      <charsetEncoding>DEFAULT_ENCODING</charsetEncoding>
      <respondOnNewConnection>0</respondOnNewConnection>
      <responseAddress></responseAddress>
      <responsePort></responsePort>
    </properties>
{transformer}
    <filter version="4.5.2">
      <elements/>
    </filter>
    <transportName>TCP Listener</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>
  <destinationConnectors/>
  <preprocessingScript>return message;</preprocessingScript>
  <postprocessingScript>return;</postprocessingScript>
  <deployScript>return;</deployScript>
  <undeployScript>return;</undeployScript>
  <properties version="4.5.2">
    <clearGlobalChannelMap>false</clearGlobalChannelMap>
    <messageStorageMode>DEVELOPMENT</messageStorageMode>
    <encryptData>false</encryptData>
    <encryptAttachments>false</encryptAttachments>
    <encryptCustomMetaData>false</encryptCustomMetaData>
    <removeContentOnCompletion>false</removeContentOnCompletion>
    <removeOnlyFilteredOnCompletion>false</removeOnlyFilteredOnCompletion>
    <removeAttachmentsOnCompletion>false</removeAttachmentsOnCompletion>
    <initialState>STARTED</initialState>
    <storeAttachments>true</storeAttachments>
    <metaDataColumns/>
    <attachmentProperties version="4.5.2">
      <type>None</type>
      <properties/>
    </attachmentProperties>
    <resourceIds class="linked-hash-map">
      <entry>
        <string>Default Resource</string>
        <string>[Default Resource]</string>
      </entry>
    </resourceIds>
  </properties>
  <exportData>
    <metadata>
      <enabled>true</enabled>
    </metadata>
    <dependentIds/>
    <dependencyIds/>
    <channelTags/>
  </exportData>
</channel>
"""

DFT_CHANNEL_TEMPLATE = """<channel version="4.5.2">
  <id>{channel_id}</id>
  <nextMetaDataId>2</nextMetaDataId>
  <name>Epic Bridges DFT^P03 Outbound</name>
  <description>Builds DFT^P03 charge messages and sends them to Epic Bridges via MLLP. Reads charges from channelMap.charges.</description>
  <revision>1</revision>
  <sourceConnector version="4.5.2">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.vm.VmReceiverProperties" version="4.5.2">
      <pluginProperties/>
      <sourceConnectorProperties version="4.5.2">
        <responseVariable>None</responseVariable>
        <respondAfterProcessing>true</respondAfterProcessing>
        <processBatch>false</processBatch>
        <firstResponse>false</firstResponse>
        <processingThreads>1</processingThreads>
        <resourceIds class="linked-hash-map">
          <entry>
            <string>Default Resource</string>
            <string>[Default Resource]</string>
          </entry>
        </resourceIds>
        <queueBufferSize>1000</queueBufferSize>
      </sourceConnectorProperties>
    </properties>
{transformer}
    <filter version="4.5.2">
      <elements/>
    </filter>
    <transportName>Channel Reader</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>
  <destinationConnectors>
    <connector version="4.5.2">
      <metaDataId>1</metaDataId>
      <name>Epic Bridges DFT MLLP</name>
      <properties class="com.mirth.connect.connectors.tcp.TcpDispatcherProperties" version="4.5.2">
        <pluginProperties/>
        <destinationConnectorProperties version="4.5.2">
          <queueEnabled>true</queueEnabled>
          <sendFirst>false</sendFirst>
          <retryIntervalMillis>10000</retryIntervalMillis>
          <regenerateTemplate>false</regenerateTemplate>
          <retryCount>3</retryCount>
          <rotate>false</rotate>
          <includeFilterTransformer>false</includeFilterTransformer>
          <threadCount>2</threadCount>
          <threadAssignmentVariable></threadAssignmentVariable>
          <validateResponse>true</validateResponse>
          <resourceIds class="linked-hash-map">
            <entry>
              <string>Default Resource</string>
              <string>[Default Resource]</string>
            </entry>
          </resourceIds>
          <queueBufferSize>1000</queueBufferSize>
          <reattachAttachments>true</reattachAttachments>
        </destinationConnectorProperties>
        <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
          <pluginPointName>MLLP</pluginPointName>
          <startOfMessageBytes>0B</startOfMessageBytes>
          <endOfMessageBytes>1C0D</endOfMessageBytes>
          <useMLLPv2>false</useMLLPv2>
          <ackBytes>06</ackBytes>
          <nackBytes>15</nackBytes>
          <maxRetries>2</maxRetries>
        </transmissionModeProperties>
        <remoteAddress>${{epic.bridges.host}}</remoteAddress>
        <remotePort>${{epic.bridges.dft.port}}</remotePort>
        <overrideLocalBinding>false</overrideLocalBinding>
        <reconnectInterval>5000</reconnectInterval>
        <receiveTimeout>30000</receiveTimeout>
        <bufferSize>65536</bufferSize>
        <keepConnectionOpen>true</keepConnectionOpen>
        <checkRemoteHost>true</checkRemoteHost>
        <responseTimeout>30000</responseTimeout>
        <ignoreResponse>false</ignoreResponse>
        <queueOnResponseTimeout>true</queueOnResponseTimeout>
        <dataTypeBinary>false</dataTypeBinary>
        <charsetEncoding>DEFAULT_ENCODING</charsetEncoding>
        <template>${{outboundDFT}}</template>
        <localAddress>0.0.0.0</localAddress>
        <localPort>0</localPort>
      </properties>
{transformer}
      <responseTransformer version="4.5.2">
        <elements/>
        <inboundDataType>HL7V2</inboundDataType>
        <outboundDataType>HL7V2</outboundDataType>
      </responseTransformer>
      <filter version="4.5.2">
        <elements/>
      </filter>
      <transportName>TCP Sender</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
      <waitForPrevious>true</waitForPrevious>
    </connector>
  </destinationConnectors>
  <preprocessingScript>return message;</preprocessingScript>
  <postprocessingScript>return;</postprocessingScript>
  <deployScript>return;</deployScript>
  <undeployScript>return;</undeployScript>
  <properties version="4.5.2">
    <clearGlobalChannelMap>false</clearGlobalChannelMap>
    <messageStorageMode>DEVELOPMENT</messageStorageMode>
    <encryptData>false</encryptData>
    <encryptAttachments>false</encryptAttachments>
    <encryptCustomMetaData>false</encryptCustomMetaData>
    <removeContentOnCompletion>false</removeContentOnCompletion>
    <removeOnlyFilteredOnCompletion>false</removeOnlyFilteredOnCompletion>
    <removeAttachmentsOnCompletion>false</removeAttachmentsOnCompletion>
    <initialState>STARTED</initialState>
    <storeAttachments>true</storeAttachments>
    <metaDataColumns/>
    <attachmentProperties version="4.5.2">
      <type>None</type>
      <properties/>
    </attachmentProperties>
    <resourceIds class="linked-hash-map">
      <entry>
        <string>Default Resource</string>
        <string>[Default Resource]</string>
      </entry>
    </resourceIds>
  </properties>
  <exportData>
    <metadata>
      <enabled>true</enabled>
    </metadata>
    <dependentIds/>
    <dependencyIds/>
    <channelTags/>
  </exportData>
</channel>
"""


def render(template: str, transformer_script_path: Path, channel_id: str, step_name: str) -> str:
    script = transformer_script_path.read_text()
    escaped = su.escape(script, {'"': "&quot;", "'": "&apos;"})
    transformer = (
        HL7_INBOUND_TEMPLATE
        .replace("{step_name}", step_name)
        .replace("{escaped_script}", escaped)
    )
    out = template.replace("{channel_id}", channel_id)
    out = out.replace("{transformer}", transformer)
    # Restore the {{ }} -> { } that we doubled to escape from str.format
    out = out.replace("{{", "{").replace("}}", "}")
    return out


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--adt-id", default="11111111-1111-1111-1111-111111111111")
    p.add_argument("--dft-id", default="22222222-2222-2222-2222-222222222222")
    args = p.parse_args()

    adt_xml = render(
        ADT_CHANNEL_TEMPLATE,
        HERE / "adt-inbound-transformer.js",
        args.adt_id,
        "Epic ADT inbound transformer",
    )
    (HERE / "adt-channel.xml").write_text(adt_xml)

    dft_xml = render(
        DFT_CHANNEL_TEMPLATE,
        HERE / "dft-outbound-transformer.js",
        args.dft_id,
        "Build DFT^P03 outbound",
    )
    (HERE / "dft-channel.xml").write_text(dft_xml)

    print("wrote adt-channel.xml + dft-channel.xml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
