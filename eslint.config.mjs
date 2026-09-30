// Auditoría estática del casino. El motivo de ser de esta configuración es una
// sola regla: `no-undef`. `node --check` solo valida SINTAXIS, así que una
// variable que no existe (ya pasó en producción con un ReferenceError dentro de
// join_room que tumbaba todo el servidor) no la detecta nadie hasta que un
// usuario pisa justo esa ruta. `npm run lint` recorre TODO el código y marca
// cualquier identificador que no esté declarado en su ámbito.
//
// Se usa la versión flat de la config (ESLint 9+). Los globals vienen del
// paquete `globals` (devDependency): node para el backend/tests y browser para
// el cliente. `io` y las librerías que carga index.html se declaran a mano.
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'data/**']
  },
  {
    files: ['server.js', 'lib/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node }
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        io: 'readonly' // socket.io-client cargado desde index.html
      }
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
