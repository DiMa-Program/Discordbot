import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Forces `DATABASE_PATH=:memory:` before any test file runs, so no test can create, read or
    // delete a database file in the working tree. See `src/__tests__/setup.ts`.
    setupFiles: ['src/__tests__/setup.ts'],
    // Registry discovery walks the real `src/features` tree, so a feature folder must never be
    // able to define a test file that also gets imported as a runtime module.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
