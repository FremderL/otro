-- Prerrequisito idempotente para instalaciones nuevas. En instalaciones históricas
-- estas tablas ya existen y CREATE IF NOT EXISTS no altera datos ni columnas.
CREATE TABLE IF NOT EXISTS montecristo_profiles (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS montecristo_seasons (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
