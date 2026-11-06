const js = require('@eslint/js');
const typescript = require('typescript-eslint');
const oxlintOverlap = require('../../tools/eslint/oxlint-overlap.cjs');

module.exports = [
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: typescript.parser
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      'no-console': 'off',
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      'no-empty': 'warn'
    }
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.js']
  },
  {
    rules: oxlintOverlap.common
  }
];
