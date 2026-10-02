CREATE TABLE IF NOT EXISTS montecristo_password_reset_challenges (
 id UUID PRIMARY KEY,
 profile_id TEXT NOT NULL REFERENCES montecristo_profiles(id) ON DELETE CASCADE,
 token_hash TEXT UNIQUE NOT NULL,
 created_by TEXT NOT NULL REFERENCES montecristo_profiles(id),
 reason TEXT NOT NULL CHECK(char_length(reason) BETWEEN 10 AND 500),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ NULL,
 CHECK(expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS montecristo_password_reset_profile_idx ON montecristo_password_reset_challenges(profile_id,created_at DESC);
CREATE INDEX IF NOT EXISTS montecristo_password_reset_expiry_idx ON montecristo_password_reset_challenges(expires_at) WHERE consumed_at IS NULL;
