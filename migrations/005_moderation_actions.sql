CREATE TABLE IF NOT EXISTS montecristo_moderation_actions (
  id UUID PRIMARY KEY,
  target_profile_id TEXT NOT NULL,
  actor_profile_id TEXT NOT NULL,
  report_id UUID NULL,
  type TEXT NOT NULL CHECK (type IN ('warning','suspension','ban','unban','chat_mute')),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 500),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_by TEXT NULL,
  revoke_reason TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS montecristo_moderation_target_idx ON montecristo_moderation_actions(target_profile_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS montecristo_moderation_active_idx ON montecristo_moderation_actions(target_profile_id) WHERE revoked_at IS NULL;
