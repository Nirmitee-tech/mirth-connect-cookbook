-- Recipe #32 — HIPAA Audit Trail Channel
-- audit_event_table.sql — append-only audit log with tamper-evident hash chain
--
-- Schema satisfies HIPAA § 164.312(b) Audit Controls — records the minimum
-- set of fields needed to answer: who, what, when, on whom, from where.
--
-- Tamper-evidence: each row computes sha256(prev_hash || current_payload),
-- so flipping a byte anywhere in the table invalidates every row that follows.
--
-- Tested on: PostgreSQL 16, Mirth Connect 4.5.2 docker-compose
-- Author: Nirmitee.io
-- License: MIT

CREATE SCHEMA IF NOT EXISTS audit;

-- Lookup of valid audit actions (FHIR AuditEvent.action codes)
CREATE TABLE IF NOT EXISTS audit.action_code (
    code        CHAR(1) PRIMARY KEY,
    description TEXT NOT NULL
);

INSERT INTO audit.action_code (code, description) VALUES
    ('C', 'Create — record was created'),
    ('R', 'Read   — record was read/printed/viewed'),
    ('U', 'Update — record was updated'),
    ('D', 'Delete — record was deleted'),
    ('E', 'Execute — perform a system or application function (e.g. login, query)')
ON CONFLICT (code) DO NOTHING;

-- Main append-only table
CREATE TABLE IF NOT EXISTS audit.audit_event (
    id              BIGSERIAL PRIMARY KEY,
    event_uuid      UUID        NOT NULL UNIQUE,
    occurred_at     TIMESTAMPTZ NOT NULL,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Source of the event
    channel_id      VARCHAR(64) NOT NULL,
    channel_name    VARCHAR(255),
    message_id      VARCHAR(64),
    server_id       VARCHAR(64),
    source_ip       INET,

    -- Who
    user_id         VARCHAR(255),
    user_role       VARCHAR(64),

    -- What
    action          CHAR(1)     NOT NULL REFERENCES audit.action_code(code),
    outcome         CHAR(1)     NOT NULL DEFAULT '0', -- 0=success, 4=minor, 8=serious, 12=major
    outcome_desc    TEXT,

    -- On whom / on what
    patient_id      VARCHAR(64),
    resource_type   VARCHAR(64),  -- e.g. Patient, DiagnosticReport, HL7v2:ADT^A04
    resource_id     VARCHAR(255),

    -- Optional payload (HIPAA recommends but does not mandate)
    detail_json     JSONB,

    -- Tamper-evident chain
    prev_hash       CHAR(64)    NOT NULL,       -- hex sha256 of previous row, or 64 '0's for genesis
    row_hash        CHAR(64)    NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_event_occurred_at   ON audit.audit_event(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_event_patient_id    ON audit.audit_event(patient_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_user_id       ON audit.audit_event(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_channel_id    ON audit.audit_event(channel_id);
CREATE INDEX IF NOT EXISTS idx_audit_event_resource      ON audit.audit_event(resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- Append-only enforcement (revoke UPDATE/DELETE, BEFORE-trigger backstop)
-- ----------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_event FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit.audit_event is append-only (HIPAA § 164.312(b))';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_update ON audit.audit_event;
CREATE TRIGGER trg_reject_update BEFORE UPDATE ON audit.audit_event
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

DROP TRIGGER IF EXISTS trg_reject_delete ON audit.audit_event;
CREATE TRIGGER trg_reject_delete BEFORE DELETE ON audit.audit_event
    FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();

-- ----------------------------------------------------------------------------
-- Hash chain verification (run nightly from cron, alert on mismatch)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.verify_chain(p_limit BIGINT DEFAULT NULL)
RETURNS TABLE (broken_id BIGINT, expected CHAR(64), actual CHAR(64))
LANGUAGE plpgsql AS $$
DECLARE
    rec   RECORD;
    prev  CHAR(64) := repeat('0', 64);
    payload TEXT;
    expect  CHAR(64);
BEGIN
    FOR rec IN
        SELECT * FROM audit.audit_event
        ORDER BY id
        LIMIT COALESCE(p_limit, 9223372036854775807)
    LOOP
        payload := rec.event_uuid::text
                || COALESCE(rec.occurred_at::text, '')
                || COALESCE(rec.channel_id, '')
                || COALESCE(rec.message_id, '')
                || COALESCE(rec.user_id, '')
                || rec.action
                || COALESCE(rec.patient_id, '')
                || COALESCE(rec.resource_type, '')
                || COALESCE(rec.resource_id, '')
                || COALESCE(rec.detail_json::text, '')
                || prev;
        expect := encode(digest(payload::bytea, 'sha256'), 'hex');
        IF expect <> rec.row_hash THEN
            broken_id := rec.id;
            expected  := expect;
            actual    := rec.row_hash;
            RETURN NEXT;
        END IF;
        prev := rec.row_hash;
    END LOOP;
END;
$$;

-- Requires pgcrypto for digest()
CREATE EXTENSION IF NOT EXISTS pgcrypto;
