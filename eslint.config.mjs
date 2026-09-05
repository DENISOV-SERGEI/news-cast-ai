// eslint.config.mjs — flat config (ESLint 9).
// Правила только на корректность (recommended), без стилевых придирок:
// линт нужен, чтобы ловить undefined-переменные, неиспользуемые символы
// и синтаксические огрехи до рантайма и CI.
//
// @ts-check
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'coverage/', 'pending/', 'sessions/', 'drafts/'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // _-префикс — сознательно неиспользуемый аргумент (распространено в колбэках).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];