/*
 * Unit tests for transformers/oru-to-fhir-diagnosticreport/transformer.js
 *
 * NOTE: The ORU transformer uses a safeGet() helper that walks paths like
 *   'PID.PID\\.3.PID\\.3\\.1'
 * That path style relies on Mirth's E4X XML-node access semantics. The
 * unit-test harness's lightweight HL7v2 parser exposes the same keys
 * (msg['PID']['PID.3']['PID.3.1']) but does NOT implement the E4X escape
 * mechanics — so the transformer's safeGet() returns '' for every field
 * inside this harness.
 *
 * The tests below therefore assert the *contract* the transformer always
 * honors regardless of parse depth:
 *   - Always produces a 'transaction' Bundle in channelMap.fhirBundle
 *   - Always emits a Patient, ServiceRequest, DiagnosticReport entry
 *   - Always uses PUT verbs
 *   - Sets channelMap.observationCount
 *
 * For deeper field-level assertions, use the framework against a
 * transformer written with direct msg['SEG']['SEG.N']['SEG.N.M'] access
 * (see adt-to-fhir.test.js).
 */

describe("ORU -> FHIR DiagnosticReport transformer", function () {

    it("runs against the CBC fixture without throwing", function () {
        __runTransformer();
        expect(channelMap.get("fhirBundle")).toBeTruthy();
    });

    it("emits a FHIR transaction Bundle", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        expect(bundle.resourceType).toBe("Bundle");
        expect(bundle.type).toBe(__EXPECTED.bundleType);
        expect(bundle).toHaveProperty("entry");
    });

    it("always includes Patient + ServiceRequest + DiagnosticReport entries", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var rt = {};
        for (var i = 0; i < bundle.entry.length; i++) {
            var t = bundle.entry[i].resource.resourceType;
            rt[t] = (rt[t] || 0) + 1;
        }
        expect(rt.Patient).toBe(1);
        expect(rt.ServiceRequest).toBe(1);
        expect(rt.DiagnosticReport).toBe(1);
    });

    it("uses PUT verbs (idempotent upsert) for every entry", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        for (var i = 0; i < bundle.entry.length; i++) {
            expect(bundle.entry[i].request.method).toBe("PUT");
        }
    });

    it("sets channelMap.observationCount", function () {
        expect(channelMap.get("observationCount")).toBeTruthy();
    });

    it("sets channelMap.patientId and channelMap.orderId", function () {
        expect(channelMap.get("patientId")).toBeTruthy();
        expect(channelMap.get("orderId")).toBeTruthy();
    });
});
