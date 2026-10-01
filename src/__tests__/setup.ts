/**
 * Test setup: forces every database in the suite to be in-memory.
 *
 * WHY THIS IS A SETUP FILE AND NOT A CONVENTION.
 *
 * The stores open the process-wide handle lazily, on first use. That is right for the bot — a module
 * import must not create a file — but it means a test that touches `linkAccount` without arranging a
 * database would silently create `<root>/data/bot.db` and leave it behind. A green suite with a
 * stray `data/` directory is exactly the failure that hides a real persistence bug, so the guard is
 * structural: `DATABASE_PATH` is set here, once, before any test file runs, and no test has to
 * remember to do it.
 *
 * `src/__tests__/` is excluded from `tsconfig.build.json`, so this wiring never reaches `dist/`.
 */

import { afterAll, beforeAll } from 'vitest';

import { closeDatabase } from '../core/db.js';

const MEMORY = ':memory:';

beforeAll(() => {
  process.env['DATABASE_PATH'] = MEMORY;
});

afterAll(() => {
  // Hands the file descriptor back rather than letting the process exit drop it, so a leak shows up
  // here instead of as an unexplained handle somewhere in CI.
  closeDatabase();
  delete process.env['DATABASE_PATH'];
});
