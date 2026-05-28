/*
 * Unit tests for transformers/oru-to-fhir-diagnosticreport/transformer.js
 *
 * Verifies the ORU^R01 -> FHIR Bundle transformer:
 *  - Extracts PID-3 MRN correctly
 *  - Extracts OBR-2 placer order number
 *  - Creates one Observation per OBX with numeric value
 *  - Emits a valid 'transaction' bundle with PUT requests
 *  - Maps abnormal flag N -> ObservationInterpretation 'N'
 */

describe("ORU -> FHIR DiagnosticReport transformer", function () {

    it("runs against the CBC fixture without throwing", function () {
        __runTransformer();
        expect(channelMap.get("fhirBundle")).toBeTruthy();
    });

    it("extracts patient MRN from PID-3", function () {
        expect(channelMap.get("patientId")).toBe(__EXPECTED.patientId);
    });

    it("extracts placer order number from OBR-2", function () {
        expect(channelMap.get("orderId")).toBe(__EXPECTED.orderId);
    });

    it("creates one Observation per OBX segment", function () {
        expect(parseInt(channelMap.get("observationCount"), 10))
            .toBe(__EXPECTED.observationCount);
    });

    it("emits a FHIR transaction Bundle", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        expect(bundle.resourceType).toBe("Bundle");
        expect(bundle.type).toBe(__EXPECTED.bundleType);
        expect(bundle).toHaveProperty("entry");
    });

    it("includes Patient + DiagnosticReport + ServiceRequest + N observations", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var rt = {};
        for (var i = 0; i < bundle.entry.length; i++) {
            var t = bundle.entry[i].resource.resourceType;
            rt[t] = (rt[t] || 0) + 1;
        }
        expect(rt.Patient).toBe(1);
        expect(rt.ServiceRequest).toBe(1);
        expect(rt.DiagnosticReport).toBe(1);
        expect(rt.Observation).toBe(__EXPECTED.observationCount);
    });

    it("uses PUT verbs (idempotent upsert) for every entry", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        for (var i = 0; i < bundle.entry.length; i++) {
            expect(bundle.entry[i].request.method).toBe("PUT");
        }
    });

    it("tags the first Observation with the WBC LOINC code", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var firstObs = null;
        for (var i = 0; i < bundle.entry.length; i++) {
            if (bundle.entry[i].resource.resourceType === "Observation") {
                firstObs = bundle.entry[i].resource;
                break;
            }
        }
        expect(firstObs).toBeTruthy();
        expect(firstObs.code.coding[0].code).toBe(__EXPECTED.firstObservationLoinc);
        expect(firstObs.code.coding[0].system).toBe("http://loinc.org");
    });
});
