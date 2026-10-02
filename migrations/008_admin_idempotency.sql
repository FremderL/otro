CREATE TABLE IF NOT EXISTS montecristo_admin_idempotency (
 actor_profile_id TEXT NOT NULL,
 idempotency_key UUID NOT NULL,
 operation TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('processing','completed')),
 status_code INTEGER NULL,
 response_body JSONB NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 PRIMARY KEY(actor_profile_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS montecristo_idempotency_expiry_idx ON montecristo_admin_idempotency(expires_at);
