// ESLint 9 flat config — applies @typescript-eslint recommended-type-checked
// rules to all source files (per SRS NFR-MAINT-1).
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    // Test files are excluded from tsconfig (the typed project), so the
    // type-checked rules can't resolve them — lint them out here to match.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.d.ts', '**/*.test.ts'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['recommended-type-checked'].rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
];
