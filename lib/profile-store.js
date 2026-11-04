const fs = require('fs');
const path = require('path');
const { BaseProfileStore, cleanClubTreasury } = require('./profile-store-base');
const { INITIAL_CHIPS, AVATARS, AVATAR_IDS, avatarInfo, cleanProfile, monthKey } = require('./profile-store-shared');

// ProfileStore respaldado en un archivo JSON local (comportamiento histórico,
// usado siempre que no exista la variable de entorno DATABASE_URL — ver
// lib/profile-store-factory.js). Fase 10.1: la lógica común con el backend de
// Postgres vive en lib/profile-store-base.js; aquí solo queda la parte de E/S
// a disco, sin cambios de comportamiento respecto a versiones anteriores.
class ProfileStore extends BaseProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json'), options = {}) {
    super();
    this.backend = 'file'; // Fase 11.1: usado por server.js para decidir los techos de historial.
    this.filePath = filePath;
    this.load();
    // Fase F (A12): el arranque puede posponer la comprobación de temporada para
    // cablear antes el gancho onBeforeSeasonReset (server.js) y así no cerrar el mes
    // del casino sin consultar antes si quedan apuestas de fútbol abiertas.
    if (!options.deferSeasonCheck) this.ensureSeason();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // Formato nuevo { seasons, profiles } o legado (arreglo simple de perfiles).
      this.importJournal = data.importJournal || null;
      const list = Array.isArray(data) ? data : Array.isArray(data.profiles) ? data.profiles : [];
      if (!Array.isArray(data) && data.seasons && typeof data.seasons === 'object') {
        const current = typeof data.seasons.current === 'string' ? data.seasons.current : monthKey();
        this.seasons = {
          current,
          history: Array.isArray(data.seasons.history) ? data.seasons.history.slice(-12) : [],
          clubTreasury: cleanClubTreasury(data.seasons.clubTreasury, current)
        };
      }
      for (const raw of list) {
        const profile = cleanProfile(raw);
        if (profile.id) this.profiles.set(profile.id, profile);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('No se pudieron cargar los perfiles:', error.message);
    }
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      // Fase 8.6/8.7: el archivo guarda también las temporadas mensuales.
      fs.writeFileSync(temporary, JSON.stringify({ seasons: this.seasons, profiles: [...this.profiles.values()], importJournal: this.importJournal }, null, 2));
      fs.renameSync(temporary, this.filePath);
      return true;
    } catch (error) {
      console.warn('No se pudieron guardar los perfiles:', error.message);
      return false;
    }
  }

  async _commitGuestImport({ account, source, operationId, footballStore, deviceLinks }) {
    // Diario durable antes de tocar carteras/boletos. Un crash en cualquier
    // punto se termina al arrancar, con los mismos ids y sin volver a sumar.
    this.importJournal = { account, source, operationId };
    if (!this.saveNow()) throw new Error('No se pudo preparar la importación');
    if (footballStore?.reassignProfile) {
      const moved = await footballStore.reassignProfile(source.id, account.id);
      if (!moved) { this.importJournal = null; this.saveNow(); throw new Error('No se pudieron transferir los boletos'); }
    }
    if (deviceLinks?.reassign) await deviceLinks.reassign(source.id, account.id, Date.now());
    this._applyImportMemory({ account, source });
    if (!this.saveNow()) throw new Error('Importación preparada; se completará al arrancar');
    this.importJournal = null;
    if (!this.saveNow()) throw new Error('Importación aplicada; pendiente confirmar cierre del diario');
    return true;
  }

  persistProfile(profile) {
    if (!profile || !profile.id || this.profiles.get(profile.id) !== profile) return false;
    this.touch(profile);
    return this.saveNow() === true;
  }
}

module.exports = { ProfileStore, INITIAL_CHIPS, AVATARS, avatarInfo, AVATAR_IDS };
