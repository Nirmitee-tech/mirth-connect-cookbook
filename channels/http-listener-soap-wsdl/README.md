# SOAP/WSDL Listener — `getPatient` over FHIR Backend

Lets legacy SOAP clients (think: Java Swing portals, classic ASP, .NET WinForms apps from 2008) consume a modern FHIR R4 backend without knowing FHIR exists. Mirth terminates SOAP, calls FHIR, marshals the result back into a SOAP envelope.

```
[Legacy hospital portal] ──SOAP──► [Mirth WS Listener] ──HTTP/FHIR──► [Modern EHR]
                                          │
                                          ├── normal: <getPatientResponse>
                                          └── error : <soap:Fault>
```

## What's in this recipe

| File | Purpose |
|---|---|
| [sample.wsdl](sample.wsdl) | The WSDL exposed to clients — defines `getPatient(patientId)`, response wrapping a FHIR `Patient`, and a typed fault |
| [transformer.js](transformer.js) | Source transformer: parses SOAP request, calls backend FHIR, builds SOAP response or Fault |

## Use case

We hit this repeatedly at hospital migrations:

- A new EHR (Epic, Cerner, openEHR) goes live with FHIR.
- The old patient-portal application is in maintenance mode — replacing it would take 18 months and a vendor.
- The portal still needs to look up patients. It speaks SOAP only.

A 30-line transformer in Mirth bridges the two while the larger replacement happens at its own pace.

## Where to install

1. **Channel → Source → Connector type:** `Web Service Listener`
2. Configure:
   - **Listener address:** `0.0.0.0`
   - **Listener port:** `8089`
   - **Service name:** `PatientService`
   - **Service class:** `com.mirth.connect.connectors.ws.DefaultAcceptMessage`
     (Mirth's bundled JAX-WS class. It exposes a single `acceptMessage` operation; we override its WSDL by wrapping the SOAP body in our own envelope in the transformer.)
   - **Response variable:** `responseBody` (channelMap)
3. **Channel → Source → Transformer:** paste [transformer.js](transformer.js).
4. **Settings → Configuration Map:**

   | Key | Default | Purpose |
   |---|---|---|
   | `backend.fhir.base` | `http://localhost:8089/fhir` | The FHIR server to query (can be the FHIR Facade recipe in this cookbook!) |
   | `backend.timeout.ms` | `10000` | HTTP client timeout for the backend call |

5. Deploy.

## A note on the WSDL

Mirth's `DefaultAcceptMessage` exposes a generic `acceptMessage(String)` operation. That works for most SOAP clients (they post any envelope; we parse what we want inside). If you need a typed WSDL — one that a `wsimport` / `svcutil` tool can stub off — there are two routes:

1. **Static WSDL hosting**: serve [sample.wsdl](sample.wsdl) from any web server, point your clients there for stub generation, and let them hit Mirth's actual endpoint at `http://host:8089/ws/PatientService`. Mirth doesn't enforce that the actual WSDL matches the hosted one.

2. **Custom JAX-WS endpoint JAR**: write a small `@WebService` class implementing `getPatient(String)`, package as a JAR, drop into `custom-lib/`, point Mirth's WS Listener at it. Best fidelity, more code.

Most projects ship option 1.

## Test

1. **View the WSDL** Mirth publishes:

   ```bash
   curl -s 'http://localhost:8089/services/PatientService?wsdl' | xmllint --format -
   ```

2. **Call `getPatient`**:

   ```bash
   curl -s -X POST http://localhost:8089/services/PatientService \
     -H 'Content-Type: text/xml; charset=utf-8' \
     -H 'SOAPAction: "http://nirmitee.io/ws/patient/getPatient"' \
     -d '<?xml version="1.0" encoding="UTF-8"?>
   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:p="http://nirmitee.io/ws/patient">
     <soap:Body>
       <p:getPatientRequest><p:patientId>MRN-12345</p:patientId></p:getPatientRequest>
     </soap:Body>
   </soap:Envelope>'
   ```

   Expected (formatted):

   ```xml
   <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:p="http://nirmitee.io/ws/patient">
     <soap:Body>
       <p:getPatientResponse>
         <p:patient>
           <Patient xmlns="http://hl7.org/fhir">
             <id value="MRN-12345"/>
             <active value="true"/>
             <identifier><system value="http://hospital.example.org/mrn"/><value value="MRN-12345"/></identifier>
             <name><family value="Smith"/><given value="John"/></name>
             <gender value="male"/>
             <birthDate value="1980-01-15"/>
           </Patient>
         </p:patient>
       </p:getPatientResponse>
     </soap:Body>
   </soap:Envelope>
   ```

3. **Test the missing-id Fault**:

   ```bash
   curl -s -X POST http://localhost:8089/services/PatientService \
     -H 'Content-Type: text/xml' \
     -d '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
           <soap:Body><getPatientRequest/></soap:Body>
         </soap:Envelope>'
   ```

   Expect HTTP 400 with a `<soap:Fault>` carrying `<faultcode>soap:Client</faultcode>` and `<p:patientFault><p:code>INVALID_REQUEST</p:code>`.

4. **Test the not-found Fault** — use an MRN that doesn't exist; expect HTTP 404 + `NOT_FOUND`.

## Customize

- **Add more operations** (`createPatient`, `searchObservations`) — add a route dispatcher at the top of the transformer keyed off the SOAP body's first element name.
- **WS-Security / WS-Addressing**: terminate at a proxy that understands these (e.g. WSO2, Apache CXF in a custom JAR). Mirth's built-in WS Listener does not parse WS-Sec headers.
- **MTOM attachments** (DICOM, scanned forms): use a custom JAX-WS implementation.
- **Native FHIR XML serialization** with full namespaces / extensions: replace `patientToFhirXml()` with a call to HAPI's `XmlParser` — drop `hapi-fhir-base.jar` and `hapi-fhir-structures-r4.jar` into `custom-lib/`.

## Production considerations

- **SOAP is verbose**: a single `getPatient` is ~1.2 KB of XML overhead. Run benchmarks before claiming "FHIR replaces SOAP" — bandwidth bills can spike on high-volume integrations.
- **Idempotency**: SOAP clients often retry on socket timeout. Make sure your backend FHIR endpoint handles `GET /Patient/{id}` calls idempotently (it does, by definition).
- **Schema validation**: enforce SOAP envelope schema at a gateway, not in JS. We deliberately keep the transformer lenient (regex-based extract) to survive minor namespace prefix differences across legacy clients.
- **Logging**: SOAP bodies often contain PHI. Log only `patientId` length + status (already what `soapSummary` does); never log full envelopes.

## Files

- [sample.wsdl](sample.wsdl) — published to clients for stub generation
- [transformer.js](transformer.js) — request parsing, FHIR fetch, envelope/fault building
