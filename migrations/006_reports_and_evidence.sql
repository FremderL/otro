CREATE TABLE IF NOT EXISTS montecristo_reports (
 id UUID PRIMARY KEY, reporter_profile_id TEXT NULL, reporter_device_hash TEXT NULL,
 reported_profile_id TEXT NOT NULL, category TEXT NOT NULL,
 description TEXT NOT NULL CHECK(char_length(description) BETWEEN 10 AND 1000),
 status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'normal',
 assigned_to TEXT NULL, resolution TEXT NULL, version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS montecristo_reports_queue_idx ON montecristo_reports(status,priority,created_at);
CREATE INDEX IF NOT EXISTS montecristo_reports_target_idx ON montecristo_reports(reported_profile_id,created_at DESC);
CREATE TABLE IF NOT EXISTS montecristo_report_evidence (
 id UUID PRIMARY KEY, report_id UUID NOT NULL REFERENCES montecristo_reports(id) ON DELETE CASCADE,
 type TEXT NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS montecristo_evidence_report_idx ON montecristo_report_evidence(report_id,created_at);
