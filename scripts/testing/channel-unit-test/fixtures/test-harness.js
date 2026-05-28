/*
 * test-harness.js - Mocha-style describe()/it()/expect() helpers for Rhino.
 *
 * Provides Mirth Connect's transformer-scope globals:
 *   msg              - parsed HL7v2 fixture (PID/PV1/OBX accessor compatible)
 *   channelMap       - put/get/containsKey
 *   globalChannelMap - alias of channelMap (sufficient for unit tests)
 *   logger           - silent
 *   __runTransformer - call once to execute the loaded transformer source
 *
 * The HL7v2 parser shim is intentionally minimal — enough to drive the
 * cookbook's existing ADT / ORU transformers. For more exotic E4X access
 * patterns, run the test against a full Mirth instance instead.
 */

var __harness = (function () {
    var results = [];
    var currentSuite = "default";

    function describe(name, fn) {
        var prev = currentSuite;
        currentSuite = name;
        try { fn(); } finally { currentSuite = prev; }
    }

    function it(name, fn) {
        var t0 = java.lang.System.nanoTime();
        var passed = true;
        var err = null;
        try {
            fn();
        } catch (e) {
            passed = false;
            err = (e && e.message) ? e.message : ("" + e);
        }
        var ms = (java.lang.System.nanoTime() - t0) / 1.0e6;
        results.push({
            suite: currentSuite,
            name: name,
            passed: passed,
            duration_ms: ms,
            error: err
        });
    }

    function expect(actual) {
        return {
            toEqual: function (v) {
                var a = JSON.stringify(actual);
                var b = JSON.stringify(v);
                if (a !== b) throw new Error("expected " + b + " but got " + a);
            },
            toBe: function (v) {
                if (actual !== v) throw new Error("expected " + v + " but got " + actual);
            },
            toBeTruthy: function () {
                if (!actual) throw new Error("expected truthy, got " + actual);
            },
            toContain: function (v) {
                if (("" + actual).indexOf(v) === -1)
                    throw new Error("expected '" + actual + "' to contain '" + v + "'");
            },
            toHaveProperty: function (key) {
                if (actual === null || actual === undefined || actual[key] === undefined)
                    throw new Error("expected property '" + key + "'");
            },
            toHaveLength: function (n) {
                if (!actual || actual.length !== n)
                    throw new Error("expected length " + n + ", got " + (actual ? actual.length : "null"));
            }
        };
    }

    function flush(path) {
        var out = new java.io.PrintWriter(path);
        out.print(JSON.stringify(results));
        out.close();
    }

    return { describe: describe, it: it, expect: expect, flush: flush };
})();

var describe = __harness.describe;
var it = __harness.it;
var expect = __harness.expect;

// --- Minimal HL7v2 parser shim ---
function __parseHL7(text) {
    var segs = text.split(/\r\n|\r|\n/).filter(function (l) { return l.length > 0; });
    var root = {};

    function wrap(value) {
        return {
            toString: function () { return value; },
            length: value ? value.length : 0
        };
    }

    function build(segId, parts) {
        var seg = {};
        for (var i = 1; i < parts.length; i++) {
            var fieldName = segId + "." + i;
            var comps = parts[i].split("^");
            var fieldNode = {};
            for (var j = 0; j < comps.length; j++) {
                var compName = fieldName + "." + (j + 1);
                fieldNode[compName] = wrap(comps[j]);
            }
            fieldNode.toString = (function (v) { return function () { return v; }; })(parts[i]);
            seg[fieldName] = fieldNode;
        }
        return seg;
    }

    for (var s = 0; s < segs.length; s++) {
        var parts = segs[s].split("|");
        var segId = parts[0];
        var built = build(segId, parts);
        if (root[segId] === undefined) {
            root[segId] = built;
        } else if (root[segId].length !== undefined && root[segId][0] !== undefined) {
            root[segId].push(built);
        } else {
            root[segId] = [root[segId], built];
        }
    }
    return root;
}

var msg = __parseHL7(__FIXTURE_HL7);

var channelMap = (function () {
    var m = {};
    return {
        put: function (k, v) { m[k] = v; },
        get: function (k) { return m[k]; },
        containsKey: function (k) { return m[k] !== undefined; },
        __dump: function () { return m; }
    };
})();
var globalChannelMap = channelMap;
var globalMap = channelMap;

var logger = {
    info: function () { },
    error: function () { },
    warn: function () { },
    debug: function () { }
};

// Load() helper to execute the transformer source under harness scope.
// __TRANSFORMER_PATH is injected by the Python runner.
function __runTransformer() {
    load(__TRANSFORMER_PATH);
}
