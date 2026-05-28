-- patient_admissions: target table for the idempotent upsert recipe.
--
-- Idempotency contract:
--   Replaying the *same* ADT message must NOT create a duplicate row.
--   We use the patient's MRN as the natural primary key. The triplet
--   (mrn, encounter_id, status) is what gets reconciled on every write.
--
-- Author: Nirmitee.io | License: MIT
-- Target: PostgreSQL 13+

CREATE TABLE IF NOT EXISTS patient_admissions (
    mrn             TEXT        PRIMARY KEY,
    encounter_id    TEXT        NOT NULL,
    status          TEXT        NOT NULL,
    admission_date  TIMESTAMPTZ NOT NULL,
    last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Convenience metadata; not used by the writer but useful for audit
    payload_hash    TEXT,
    source_channel  TEXT
);

CREATE INDEX IF NOT EXISTS idx_patient_admissions_encounter
    ON patient_admissions (encounter_id);

CREATE INDEX IF NOT EXISTS idx_patient_admissions_last_updated
    ON patient_admissions (last_updated DESC);

-- Sample row for smoke testing
-- INSERT INTO patient_admissions (mrn, encounter_id, status, admission_date)
-- VALUES ('MRN-001', 'ENC-001', 'admitted', NOW())
-- ON CONFLICT (mrn) DO UPDATE
--     SET encounter_id   = EXCLUDED.encounter_id,
--         status         = EXCLUDED.status,
--         admission_date = EXCLUDED.admission_date,
--         last_updated   = NOW();
