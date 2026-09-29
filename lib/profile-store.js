const fs = require('fs');
const path = require('path');
const { BaseProfileStore } = require('./profile-store-base');
const { INITIAL_CHIPS, AVATARS, AVATAR_IDS, avatarInfo, cleanProfile, monthKey } = require('./profile-store-shared');

// ProfileStore respaldado en un archivo JSON local (comportamiento histórico,
// usado siempre que no exista la variable de entorno DATABASE_URL — ver
// lib/profile-store-factory.js). Fase 10.1: la lógica común con el backend de
// Postgres vive en lib/profile-store-base.js; aquí solo queda la parte de E/S
// a disco, sin cambios de comportamiento respecto a versiones anteriores.
class ProfileStore extends BaseProfileStore {
  constructor(filePath = path.join(process.cwd(), 'data', 'profiles.json')) {
    super();
    this.filePath = filePath;
    this.load();
    this.ensureSeason();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      // Formato nuevo { seasons, profiles } o legado (arreglo simple de perfiles).
      const list = Array.isArray(data) ? data : Array.isArray(data.profiles) ? data.profiles : [];
      if (!Array.isArray(data) && data.seasons && typeof data.seasons === 'object') {
        this.seasons = {
          current: typeof data.seasons.current === 'string' ? data.seasons.current : monthKey(),
          history: Array.isArray(data.seasons.history) ? data.seasons.history.slice(-12) : []
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
      fs.writeFileSync(temporary, JSON.stringify({ seasons: this.seasons, profiles: [...this.profiles.values()] }, null, 2));
      fs.renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn('No se pudieron guardar los perfiles:', error.message);
    }
  }
}

module.exports = { ProfileStore, INITIAL_CHIPS, AVATARS, avatarInfo, AVATAR_IDS };
