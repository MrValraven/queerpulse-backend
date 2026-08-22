// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      // The `unsafe-*` family (reads/calls/returns THROUGH an `any`) stays
      // visible as a warning rather than blocking CI — matching the frontend's
      // tuning exactly. `any` is too common across untyped third-party surface
      // (and test mocks) to gate on; promote these to error as the tail is
      // typed out.
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      // `_`-prefixed names are the codebase's "deliberately unused" marker:
      // an interface method that ignores an argument
      // (`createSession(_userId)`), and the omit-by-destructuring idiom
      // (`const { startAt: _startAt, ...patch } = dto`) that builds a patch
      // without the fields it must not carry. `ignoreRestSiblings` covers the
      // latter shape even when the omitted key keeps its own name.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // A migration's `up`/`down` satisfy `MigrationInterface`, which types both
    // as returning a Promise. Several legitimately await nothing: a `down()`
    // that is deliberately irreversible throws instead (Postgres cannot drop
    // an enum value), and a few `up()`s only call synchronous helpers. `async`
    // there is the interface's requirement, not a forgotten await — and an
    // applied migration is frozen history that must not be edited to satisfy
    // a lint rule.
    files: ['src/migrations/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Spec mocks stand in for async APIs, so `jest.fn(async () => value)` is
    // how a mock is typed to return a promise; there is nothing for it to
    // await. `@typescript-eslint/no-floating-promises` (error, above) is what
    // actually catches a forgotten await in a test.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
);
