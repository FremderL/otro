-- Bitácora administrativa append-only desde la aplicación.
CREATE TABLE IF NOT EXISTS montecristo_audit_log (
  id UUID PRIMARY KEY,
  actor_profile_id TEXT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('system', 'moderator', 'admin')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NULL,
  request_id UUID NOT NULL,
  ip_hash TEXT NULL,
  before_data JSONB NULL,
  after_data JSONB NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS montecristo_audit_created_idx
  ON montecristo_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS montecristo_audit_actor_idx
  ON montecristo_audit_log (actor_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS montecristo_audit_target_idx
  ON montecristo_audit_log (target_type, target_id, created_at DESC);

-- El rol de base usado por la aplicación debe recibir INSERT y SELECT, pero no
-- UPDATE/DELETE sobre esta tabla. Ese GRANT depende del proveedor y se aplica
-- en el runbook de despliegue, donde se conoce el nombre real del rol.
