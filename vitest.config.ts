import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/**/*.test.mjs` is the deploy toolchain. It sits outside `src/` because it is not part
    // of the shipped application and must never be compiled into `dist/`, and it is written in ESM
    // JavaScript because the file under test is. Both suites are offline: nothing here opens a
    // connection, and the deploy tests exist precisely so that checking the deploy does not require
    // running a deploy.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Forces `DATABASE_PATH=:memory:` before any test file runs, so no test can create, read or
    // delete a database file in the working tree. See `src/__tests__/setup.ts`.
    setupFiles: ['src/__tests__/setup.ts'],
    // Registry discovery walks the real `src/features` tree, so a feature folder must never be
    // able to define a test file that also gets imported as a runtime module.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
