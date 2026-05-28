-- =====================================================================
-- Source schema for the Database Reader CDC Polling recipe.
-- Run once against your PostgreSQL instance:
--   psql -h localhost -U mirth -d cdc_demo -f source-table.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS lab_results (
    -- Surrogate key, monotonic — used as a tie-breaker for the watermark
    result_id     bigserial   PRIMARY KEY,

    -- Business keys
    mrn           text        NOT NULL,
    accession_num text        UNIQUE NOT NULL,

    -- Observation payload
    loinc_code    text        NOT NULL,
    loinc_display text,
    value_num     numeric,
    value_text    text,
    units         text,
    abnormal_flag char(1),
    result_status text        NOT NULL DEFAULT 'final',

    -- The all-important audit columns the CDC poller uses
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Index that makes the polling query cheap.
-- Always (updated_at, result_id) together so the tie-break order is stable.
CREATE INDEX IF NOT EXISTS lab_results_updated_idx
    ON lab_results (updated_at, result_id);

-- Trigger to keep updated_at fresh on every UPDATE.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lab_results_touch_updated_at ON lab_results;
CREATE TRIGGER lab_results_touch_updated_at
    BEFORE UPDATE ON lab_results
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- =====================================================================
-- Seed: 3 rows the poller will pick up on first run.
-- =====================================================================

INSERT INTO lab_results (mrn, accession_num, loinc_code, loinc_display, value_num, units, abnormal_flag)
VALUES
    ('MRN-001', 'ACC-2026-001', '4548-4', 'Hemoglobin A1c',         7.2, '%',     'H'),
    ('MRN-002', 'ACC-2026-002', '2345-7', 'Glucose [Mass/volume]', 142,  'mg/dL', 'H'),
    ('MRN-003', 'ACC-2026-003', '2160-0', 'Creatinine',             0.9, 'mg/dL', 'N')
ON CONFLICT (accession_num) DO NOTHING;
