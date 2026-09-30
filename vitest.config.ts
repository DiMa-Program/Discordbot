import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Registry discovery walks the real `src/features` tree, so a feature folder must never be
    // able to define a test file that also gets imported as a runtime module.
    exclude: ['node_modules/**', 'dist/**'],
  },
});
