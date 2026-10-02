-- Fase 1: sesiones opacas y revocables. El token en claro nunca se persiste.
CREATE TABLE IF NOT EXISTS montecristo_account_sessions (
  id UUID PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES montecristo_profiles(id) ON DELETE CASCADE,
  token_hash BYTEA UNIQUE NOT NULL,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoke_reason TEXT NULL,
  ip_hash TEXT NULL,
  user_agent_hash TEXT NULL,
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (revoked_at IS NULL OR char_length(revoke_reason) > 0)
);

CREATE INDEX IF NOT EXISTS montecristo_sessions_profile_idx
  ON montecristo_account_sessions (profile_id);
CREATE INDEX IF NOT EXISTS montecristo_sessions_expiry_idx
  ON montecristo_account_sessions (absolute_expires_at)
  WHERE revoked_at IS NULL;
