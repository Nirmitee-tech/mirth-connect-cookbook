#!/usr/bin/env python3
"""
build-channels.py - Emit Mirth channel XMLs for OpenEMR HL7v2 bidirectional.

Reads transformer scripts (adt-inbound-transformer.js,
oru-outbound-transformer.js) and produces:
  - adt-inbound.xml   (OpenEMR ADT listener -> normalised channelMap)
  - oru-outbound.xml  (lab results -> OpenEMR over MLLP)

Tested on: Mirth Connect 4.5.2
Author: Nirmitee.io | License: MIT
"""
from __future__ import annotations

import argparse
import xml.sax.saxutils as su
from pathlib import Path

HERE = Path(__file__).parent

HL7_INBOUND_TRANSFORMER = """    <transformer version="4.5.2">
      <elements>
        <com.mirth.connect.plugins.javascriptstep.JavaScriptStep version="4.5.2">
          <name>__STEP_NAME__</name>
          <sequenceNumber>0</sequenceNumber>
          <enabled>true</enabled>
          <script>__ESCAPED_SCRIPT__</script>
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


ADT_TEMPLATE = """<channel version="4.5.2">
  <id>__CHANNEL_ID__</id>
  <nextMetaDataId>1</nextMetaDataId>
  <name>OpenEMR ADT Inbound</name>
  <description>Receives ADT from OpenEMR HL7 module. Promotes PID-2 to MRN, normalises phone, fixes missing MSH-9.2.</description>
  <revision>1</revision>
  <sourceConnector version="4.5.2">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.tcp.TcpReceiverProperties" version="4.5.2">
      <pluginProperties/>
      <listenerConnectorProperties version="4.5.2">
        <host>0.0.0.0</host>
        <port>6611</port>
      </listenerConnectorProperties>
      <sourceConnectorProperties version="4.5.2">
        <responseVariable>Auto-generate (After source transformer)</responseVariable>
        <respondAfterProcessing>true</respondAfterProcessing>
        <processBatch>false</processBatch>
        <firstResponse>true</firstResponse>
        <processingThreads>2</processingThreads>
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
      <maxConnections>10</maxConnections>
      <keepConnectionOpen>true</keepConnectionOpen>
      <dataTypeBinary>false</dataTypeBinary>
      <charsetEncoding>DEFAULT_ENCODING</charsetEncoding>
      <respondOnNewConnection>0</respondOnNewConnection>
      <responseAddress></responseAddress>
      <responsePort></responsePort>
    </properties>
__TRANSFORMER__
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

ORU_TEMPLATE = """<channel version="4.5.2">
  <id>__CHANNEL_ID__</id>
  <nextMetaDataId>2</nextMetaDataId>
  <name>OpenEMR ORU Outbound</name>
  <description>Builds ORU^R01 from channelMap.labResultJson and dispatches to OpenEMR HL7 receiver via MLLP.</description>
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
__TRANSFORMER__
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
      <name>OpenEMR MLLP</name>
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
          <threadCount>1</threadCount>
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
        <remoteAddress>${openemr.host}</remoteAddress>
        <remotePort>${openemr.port}</remotePort>
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
        <template>${outboundOru}</template>
        <localAddress>0.0.0.0</localAddress>
        <localPort>0</localPort>
      </properties>
__TRANSFORMER__
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


def build(template: str, channel_id: str, transformer_script: Path, step_name: str) -> str:
    script = transformer_script.read_text()
    escaped = su.escape(script, {'"': "&quot;", "'": "&apos;"})
    transformer = (
        HL7_INBOUND_TRANSFORMER
        .replace("__STEP_NAME__", step_name)
        .replace("__ESCAPED_SCRIPT__", escaped)
    )
    return (
        template
        .replace("__CHANNEL_ID__", channel_id)
        .replace("__TRANSFORMER__", transformer)
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--adt-id", default="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    p.add_argument("--oru-id", default="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    args = p.parse_args()

    (HERE / "adt-inbound.xml").write_text(
        build(ADT_TEMPLATE, args.adt_id, HERE / "adt-inbound-transformer.js", "OpenEMR ADT normaliser")
    )
    (HERE / "oru-outbound.xml").write_text(
        build(ORU_TEMPLATE, args.oru_id, HERE / "oru-outbound-transformer.js", "OpenEMR ORU builder")
    )
    print("wrote adt-inbound.xml + oru-outbound.xml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
