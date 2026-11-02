import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/', 'dist/', 'release/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/main/**',
      'src/preload/**',
      'src/backend/**',
      'test/**',
      '*.config.*',
      'electron-builder.cjs',
      'scripts/**',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // V8's linear-time regex flag, which the backend runs with (src/shared/backend-v8-flags.json).
    rules: { 'no-invalid-regexp': ['error', { allowConstructorFlags: ['l'] }] },
  },
  {
    // Plain CommonJS: build config, and scripts that run in Electron as CommonJS.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // The renderer must reach Node and Electron only through the preload bridge.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*'],
              message: 'The renderer has no Node access. Use the preload bridge.',
            },
            {
              group: ['**/backend/**', '**/main/**'],
              message: 'Only shared/ code may be imported by the renderer.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
