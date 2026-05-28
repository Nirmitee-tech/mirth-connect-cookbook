-- Destination 2 target table for the fan-out recipe.
-- Run this once against your warehouse / OLTP DB before deploying the channel.

CREATE TABLE IF NOT EXISTS lab_results (
    id              BIGSERIAL PRIMARY KEY,
    message_id      TEXT NOT NULL,
    mrn             TEXT NOT NULL,
    patient_name    TEXT NOT NULL,
    dob             TEXT,
    sex             TEXT,
    order_id        TEXT,
    test_code       TEXT NOT NULL,
    test_name       TEXT NOT NULL,
    ordered_at      TEXT,
    ordering_md     TEXT,
    has_abnormal    BOOLEAN NOT NULL DEFAULT FALSE,
    observations    JSONB NOT NULL,
    api_ack_id      TEXT,
    api_status      TEXT,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id)
);

-- The MRN index covers patient timelines; the abnormal index supports the
-- common "what's flagged in the last hour?" query. The api_status index
-- helps find rows where the downstream API call failed and needs replay.
CREATE INDEX IF NOT EXISTS lab_results_mrn_idx          ON lab_results (mrn, received_at DESC);
CREATE INDEX IF NOT EXISTS lab_results_abnormal_idx     ON lab_results (received_at DESC) WHERE has_abnormal;
CREATE INDEX IF NOT EXISTS lab_results_api_status_idx   ON lab_results (api_status, received_at DESC) WHERE api_status != 'ACK_OK';
