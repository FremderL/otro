-- Vínculo durable dispositivo→cuenta y diario de importación invitado→cuenta.
CREATE TABLE IF NOT EXISTS montecristo_device_links (
  device_hash TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'account' CHECK(mode IN ('account','guest')),
  linked_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS montecristo_device_links_profile ON montecristo_device_links(profile_id);
CREATE TABLE IF NOT EXISTS montecristo_import_journal (
  id SMALLINT PRIMARY KEY CHECK(id=1), data JSONB NOT NULL
);
