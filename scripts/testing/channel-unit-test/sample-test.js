/*
 * sample-test.js - Template you can copy when adding a new test.
 *
 * Pair this file with a *.meta.json alongside:
 *
 *   {
 *     "transformer": "transformers/<your-recipe>/transformer.js",
 *     "fixture_hl7": "your-fixture.hl7",
 *     "expected":    "your-fixture.expected.json"
 *   }
 *
 * Globals provided by the harness:
 *   - msg              parsed HL7v2 fixture
 *   - channelMap       Mirth-compatible map (put / get / containsKey)
 *   - globalChannelMap alias of channelMap
 *   - logger           silent logger
 *   - __EXPECTED       parsed contents of <fixture>.expected.json
 *   - __runTransformer call to execute the transformer-under-test
 *
 * Matchers: toBe / toEqual / toBeTruthy / toContain / toHaveProperty / toHaveLength
 */

describe("Sample transformer", function () {

    it("populates channelMap.fhirBundle", function () {
        __runTransformer();
        expect(channelMap.get("fhirBundle")).toBeTruthy();
    });

    it("emits the expected number of entries", function () {
        var bundle = JSON.parse(channelMap.get("fhirBundle"));
        expect(bundle.entry).toHaveLength(__EXPECTED.entryCount);
    });
});
