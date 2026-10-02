'use strict';

const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, io: 'readonly' }
    }
  }
];
