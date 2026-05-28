/*
 * Unit tests for transformers/adt-to-fhir-bundle/transformer.js
 *
 * The ADT transformer also probes tx.fhir.org via Apache HttpClient. That
 * call is wrapped in a try/catch and stores its result in channelMap.
 * In the unit-test harness Apache HttpClient is not on the classpath, so
 * we expect txTestResult to start with 'ERROR:' or 'CLASS_FOUND' — the
 * transformer must still produce a complete bundle regardless.
 */

describe("ADT -> FHIR Bundle transformer", function () {

    it("runs against the A01 sepsis fixture", function () {
        __runTransformer();
        expect(channelMap.get("fhirBundle")).toBeTruthy();
    });

    it("emits a valid transaction Bundle", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        expect(bundle.resourceType).toBe("Bundle");
        expect(bundle.type).toBe("transaction");
    });

    it("includes Patient, Encounter, Organization, Practitioner", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var seen = {};
        for (var i = 0; i < bundle.entry.length; i++) {
            seen[bundle.entry[i].resource.resourceType] = true;
        }
        expect(seen.Patient).toBe(true);
        expect(seen.Encounter).toBe(true);
        expect(seen.Organization).toBe(true);
        expect(seen.Practitioner).toBe(true);
    });

    it("links Patient.id to the PID-3 MRN", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var pt = null;
        for (var i = 0; i < bundle.entry.length; i++) {
            if (bundle.entry[i].resource.resourceType === "Patient") {
                pt = bundle.entry[i].resource;
                break;
            }
        }
        expect(pt.id).toBe(__EXPECTED.mrn);
    });

    it("creates a Condition with the ICD-10 sepsis code A41.9", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        var conditions = [];
        for (var i = 0; i < bundle.entry.length; i++) {
            if (bundle.entry[i].resource.resourceType === "Condition") {
                conditions.push(bundle.entry[i].resource);
            }
        }
        expect(conditions).toHaveLength(1);
        expect(conditions[0].code.coding[0].code).toBe(__EXPECTED.diagnosis);
    });

    it("fires the SEP-1 + ICU + geriatric flags for an elderly inpatient sepsis admit", function () {
        var n = parseInt(channelMap.get("flagCount"), 10);
        expect(n).toBe(__EXPECTED.expectedFlagCount);
    });

    it("emits exactly 1 STAT/URGENT alert for sepsis", function () {
        var n = parseInt(channelMap.get("alertCount"), 10);
        expect(n).toBe(__EXPECTED.expectedAlertCount);
    });

    it("stores businessRules JSON with facility + ward mappings", function () {
        var rules = JSON.parse(channelMap.get("businessRules"));
        expect(rules.mappings.facility).toContain("MGH");
        expect(rules.mappings.ward).toContain("ICU");
    });
});
