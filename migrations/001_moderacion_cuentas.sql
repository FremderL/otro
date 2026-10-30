-- Tablas aditivas para cuentas, reportes y moderación. Los perfiles existentes
-- pertenecen a PgProfileStore; no se cambia su estructura ni sus saldos.
CREATE TABLE IF NOT EXISTS montecristo_account_sessions (
 id UUID PRIMARY KEY, profile_id TEXT NOT NULL, token_hash BYTEA NOT NULL UNIQUE,
 session_version INTEGER NOT NULL, role TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
 idle_expires_at TIMESTAMPTZ NOT NULL, absolute_expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ, revoke_reason TEXT, mfa_verified_at TIMESTAMPTZ,
 ip_hash TEXT, user_agent_hash TEXT
);
CREATE INDEX IF NOT EXISTS montecristo_sessions_profile_idx ON montecristo_account_sessions(profile_id);
CREATE INDEX IF NOT EXISTS montecristo_sessions_expiry_idx ON montecristo_account_sessions(absolute_expires_at);
CREATE TABLE IF NOT EXISTS montecristo_audit_log (
 id UUID PRIMARY KEY, actor_profile_id TEXT, actor_role TEXT NOT NULL,
 action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, request_id UUID,
 ip_hash TEXT, before_data JSONB, after_data JSONB, reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS montecristo_audit_created_idx ON montecristo_audit_log(created_at);
CREATE TABLE IF NOT EXISTS montecristo_moderation_actions (
 id UUID PRIMARY KEY, target_profile_id TEXT NOT NULL, actor_profile_id TEXT NOT NULL,
 report_id UUID, type TEXT NOT NULL, reason TEXT NOT NULL,
 starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ, metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS montecristo_moderation_target_idx ON montecristo_moderation_actions(target_profile_id,starts_at DESC);
CREATE TABLE IF NOT EXISTS montecristo_reports (
 id UUID PRIMARY KEY, reporter_profile_id TEXT, reporter_device_hash TEXT,
 reported_profile_id TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL, priority TEXT NOT NULL, assigned_to TEXT, resolution TEXT,
 created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, resolved_at TIMESTAMPTZ,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS montecristo_reports_queue_idx ON montecristo_reports(status,priority,created_at);
CREATE TABLE IF NOT EXISTS montecristo_report_evidence (
 id UUID PRIMARY KEY, report_id UUID NOT NULL REFERENCES montecristo_reports(id) ON DELETE CASCADE,
 type TEXT NOT NULL, snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS montecristo_evidence_report_idx ON montecristo_report_evidence(report_id,created_at);
CREATE TABLE IF NOT EXISTS montecristo_password_reset_challenges (
 id UUID PRIMARY KEY, profile_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT, reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS montecristo_password_reset_expiry_idx ON montecristo_password_reset_challenges(expires_at);
CREATE TABLE IF NOT EXISTS montecristo_admin_idempotency (
 actor_profile_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation TEXT NOT NULL,
 request_hash TEXT NOT NULL, state TEXT NOT NULL, status_code INTEGER, response_body JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(actor_profile_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS montecristo_idempotency_expiry_idx ON montecristo_admin_idempotency(expires_at);
