import tseslint from 'typescript-eslint';

/**
 * Flat config. Type-checked rules are deliberately not enabled: `tsconfig.json`
 * excludes `test/`, and wiring the project service across both source trees
 * costs more than it catches here. Strict TypeScript already covers the type
 * errors; these rules cover the runtime mistakes it cannot see.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.npmcache/**', '.mcp-inspector/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // A tool result is attacker-influenced data. Silent unused values in the
      // parsers usually mean a field was dropped from the output.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // `any` erases the contract this server publishes to clients.
      '@typescript-eslint/no-explicit-any': 'error',
      // Prefer `import type` so type-only imports never reach the runtime graph.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Scripts and tests run outside the published build and may log freely.
    files: ['scripts/**/*.mjs', 'test/**/*.ts'],
    rules: {
      'no-console': 'off',
      // Tests assert against parsed JSON whose shape is the point of the test.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
