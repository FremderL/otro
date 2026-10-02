-- Los perfiles se persisten mediante snapshots con debounce. Una cuenta recién
-- vinculada puede solicitar su primera sesión antes de que su fila termine de
-- escribirse; la FK convertiría esa condición normal en un login fallido.
-- La aplicación valida la existencia del perfil en cada resolución de sesión,
-- por lo que el índice conserva eficiencia sin acoplar ambos ciclos de escritura.
ALTER TABLE montecristo_account_sessions
  DROP CONSTRAINT IF EXISTS montecristo_account_sessions_profile_id_fkey;
