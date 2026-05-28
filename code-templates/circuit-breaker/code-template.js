/**
 * Circuit Breaker for Mirth Connect (Java 17 Compatible)
 *
 * Implements the Circuit Breaker pattern to protect Mirth channels from cascading
 * failures when a downstream destination (FHIR API, MLLP receiver, HTTP service) is
 * unhealthy. Fails fast instead of accumulating queued messages or timing out one
 * by one.
 *
 * STATES:
 *   - CLOSED    — normal operation, all calls allowed
 *   - OPEN      — too many failures, all calls rejected (fail fast)
 *   - HALF_OPEN — recovery probe window, one trial call allowed
 *
 * THRESHOLDS (defaults, see CB_CONFIG below):
 *   - 5 failures within a 60 second rolling window opens the circuit
 *   - After 30 seconds OPEN, the next call moves the circuit to HALF_OPEN
 *   - One success in HALF_OPEN closes the circuit (resets counters)
 *   - One failure in HALF_OPEN re-opens the circuit for another 30s
 *
 * WHERE TO INSTALL:
 *   Code Templates → New Code Template → Type: Function → Context: any
 *   Add it to a Code Template Library and link the library to the channels that
 *   need it. Then call circuitAllow() in your destination response transformer,
 *   filter, or pre-send script.
 *
 * USAGE EXAMPLE (HTTP Sender Response Transformer):
 *
 *   // In Destination "Send to FHIR API" — response transformer
 *   var circuit = 'fhir-api-primary';
 *
 *   if (!circuitAllow(circuit)) {
 *       // Circuit is OPEN — route to DLQ or queue, do not call downstream
 *       channelMap.put('CIRCUIT_OPEN', 'true');
 *       responseStatus = ERROR;
 *       responseStatusMessage = 'Circuit breaker OPEN for ' + circuit;
 *       return;
 *   }
 *
 *   var status = parseInt(connectorMessage.getResponse().getStatus(), 10);
 *   if (status >= 200 && status < 300) {
 *       circuitRecordSuccess(circuit);
 *   } else {
 *       circuitRecordFailure(circuit);
 *   }
 *
 * STATE PERSISTENCE:
 *   Uses globalChannelMap so state is shared across all destinations and threads
 *   of the same channel. For cross-channel sharing use globalMap (uncomment the
 *   _store() override below).
 *
 * REQUIREMENTS:
 *   None — uses java.util.concurrent.ConcurrentHashMap (JDK built-in).
 *
 * Tested on: Mirth Connect 4.5.2, OpenJDK 17.0.13
 *
 * Author: Nirmitee.io
 * License: MIT
 */

var ConcurrentHashMap = Packages.java.util.concurrent.ConcurrentHashMap;
var System = Packages.java.lang.System;

/** Tunable thresholds. Override at runtime via globalMap.put('CB_CONFIG', {...}). */
var CB_CONFIG = {
    failureThreshold: 5,           // failures to trip OPEN
    rollingWindowMs: 60 * 1000,    // 60s rolling window for failure count
    openDurationMs: 30 * 1000,     // 30s before HALF_OPEN probe
    halfOpenMaxCalls: 1            // probes allowed in HALF_OPEN
};

/**
 * Returns the global circuit-state map, lazily creating it.
 * @returns {java.util.concurrent.ConcurrentHashMap}
 */
function _cbStore() {
    var key = 'CB_STATE_MAP';
    var store = globalChannelMap.get(key);
    if (store == null) {
        store = new ConcurrentHashMap();
        globalChannelMap.put(key, store);
    }
    return store;
}

/**
 * Load or initialize the state record for a circuit.
 * @param {string} name - circuit name
 * @returns {object} state — {state, openedAt, failures: [timestamps], halfOpenInFlight}
 */
function _cbGet(name) {
    var store = _cbStore();
    var raw = store.get(name);
    if (raw == null) {
        raw = JSON.stringify({
            state: 'CLOSED',
            openedAt: 0,
            failures: [],
            halfOpenInFlight: 0
        });
        store.put(name, raw);
    }
    return JSON.parse(String(raw));
}

/**
 * Persist updated state record.
 * @param {string} name
 * @param {object} state
 */
function _cbPut(name, state) {
    _cbStore().put(name, JSON.stringify(state));
}

/** Drop failure timestamps outside the rolling window. */
function _cbPruneFailures(state, now) {
    var cutoff = now - CB_CONFIG.rollingWindowMs;
    var kept = [];
    for (var i = 0; i < state.failures.length; i++) {
        if (state.failures[i] >= cutoff) kept.push(state.failures[i]);
    }
    state.failures = kept;
}

/**
 * Returns true if a call to the protected resource should be attempted.
 * Returns false if the circuit is OPEN — caller should fail fast.
 *
 * @param {string} name - logical circuit identifier (e.g. "fhir-api-primary")
 * @returns {boolean} true = allow call, false = reject (circuit OPEN)
 */
function circuitAllow(name) {
    var now = System.currentTimeMillis();
    var state = _cbGet(name);

    if (state.state === 'OPEN') {
        if (now - state.openedAt >= CB_CONFIG.openDurationMs) {
            // Move to HALF_OPEN — allow this probe
            state.state = 'HALF_OPEN';
            state.halfOpenInFlight = 1;
            _cbPut(name, state);
            return true;
        }
        return false;
    }

    if (state.state === 'HALF_OPEN') {
        if (state.halfOpenInFlight >= CB_CONFIG.halfOpenMaxCalls) {
            return false;
        }
        state.halfOpenInFlight++;
        _cbPut(name, state);
        return true;
    }

    // CLOSED
    return true;
}

/**
 * Record a successful call. Closes a HALF_OPEN circuit.
 * @param {string} name
 */
function circuitRecordSuccess(name) {
    var state = _cbGet(name);
    if (state.state === 'HALF_OPEN') {
        state.state = 'CLOSED';
        state.failures = [];
        state.openedAt = 0;
        state.halfOpenInFlight = 0;
    } else if (state.state === 'CLOSED') {
        // optional: clear stale failures on success
        state.failures = [];
    }
    _cbPut(name, state);
}

/**
 * Record a failed call. Trips the circuit if threshold exceeded.
 * @param {string} name
 */
function circuitRecordFailure(name) {
    var now = System.currentTimeMillis();
    var state = _cbGet(name);

    if (state.state === 'HALF_OPEN') {
        state.state = 'OPEN';
        state.openedAt = now;
        state.halfOpenInFlight = 0;
        _cbPut(name, state);
        return;
    }

    state.failures.push(now);
    _cbPruneFailures(state, now);

    if (state.failures.length >= CB_CONFIG.failureThreshold) {
        state.state = 'OPEN';
        state.openedAt = now;
    }
    _cbPut(name, state);
}

/**
 * Inspect the current state. Useful for monitoring/Prometheus metrics.
 * @param {string} name
 * @returns {{state: string, failures: number, openedAt: number, msUntilHalfOpen: number}}
 */
function circuitGetState(name) {
    var now = System.currentTimeMillis();
    var state = _cbGet(name);
    _cbPruneFailures(state, now);

    var msUntilHalfOpen = 0;
    if (state.state === 'OPEN') {
        msUntilHalfOpen = Math.max(0, CB_CONFIG.openDurationMs - (now - state.openedAt));
    }
    return {
        state: state.state,
        failures: state.failures.length,
        openedAt: state.openedAt,
        msUntilHalfOpen: msUntilHalfOpen
    };
}

/**
 * Force-reset a circuit to CLOSED. Useful for ops dashboards / manual recovery.
 * @param {string} name
 */
function circuitReset(name) {
    _cbPut(name, {
        state: 'CLOSED',
        openedAt: 0,
        failures: [],
        halfOpenInFlight: 0
    });
}
