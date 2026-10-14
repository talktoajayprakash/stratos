import {importX} from 'eslint-plugin-import-x';
import globals from 'globals';
import gts from 'gts';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.generated/**',
      '**/generated/**',
      '.stratos/**',
    ],
  },
  ...gts,
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: globals.node,
    },
    plugins: {'import-x': importX},
    rules: {
      curly: ['error', 'all'],
      'one-var': ['error', 'never'],
      'no-new-wrappers': 'error',
      'no-object-constructor': 'error',
      'prefer-const': ['error', {ignoreReadBeforeAssign: true}],
      'import-x/first': 'error',
      'import-x/no-duplicates': ['error', {'prefer-inline': true}],
      'import-x/no-default-export': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
          ],
          pathGroups: [{pattern: '@stratoscli/stratos', group: 'external'}],
          'newlines-between': 'always',
          alphabetize: {order: 'asc', caseInsensitive: true},
        },
      ],
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/array-type': ['error', {default: 'array-simple'}],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {fixStyle: 'inline-type-imports'},
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {ignoreRestSiblings: true},
      ],
    },
  },
  {
    files: ['eslint.config.mjs'],
    rules: {'import-x/no-default-export': 'off'},
  },
  {
    files: ['examples/*/workflow.ts'],
    rules: {'import-x/no-default-export': 'off'},
  },
];
