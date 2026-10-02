-- Marca la elevación MFA de una sesión concreta. No basta con que el perfil
-- tenga MFA configurado: cada login de personal debe verificarlo nuevamente.
ALTER TABLE montecristo_account_sessions
  ADD COLUMN IF NOT EXISTS mfa_verified_at TIMESTAMPTZ NULL;
