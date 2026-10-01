import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../core/db.js';
import {
  configureGreeting,
  getGreetingSettings,
  isGreetingEnabled,
  resetGreetingSettings,
} from './greeting-store.js';

const GUILD = '123456789012345678';

beforeEach(() => {
  resetGreetingSettings();
});

describe('greeting store', () => {
  it('is disabled for a guild that never opted in', () => {
    expect(getGreetingSettings(GUILD)).toEqual({ enabled: false, channelId: null });
    expect(isGreetingEnabled(GUILD)).toBe(false);
  });

  it('stays silent when enabled without a target channel', () => {
    configureGreeting(GUILD, { enabled: true, channelId: null });
    expect(isGreetingEnabled(GUILD)).toBe(false);
  });

  it('becomes active only when both the flag and a channel are set', () => {
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    expect(isGreetingEnabled(GUILD)).toBe(true);
  });

  it('disables again but remembers the configured channel', () => {
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    configureGreeting(GUILD, { enabled: false, channelId: '200000000000000001' });
    expect(isGreetingEnabled(GUILD)).toBe(false);
    expect(getGreetingSettings(GUILD).channelId).toBe('200000000000000001');
  });

  it('keeps guilds isolated from one another', () => {
    const other = '987654321098765432';
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    expect(isGreetingEnabled(other)).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Storage                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Temp directories this file created.
 *
 * Under the OS temp directory, never the working tree. A test that leaves a `data/` directory or a
 * `.db` file in the repository is a failing test, so the one test that genuinely needs a file gets
 * one that is removed again in `afterEach`.
 */
const scratchDirs: string[] = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Runs `body` twice against the SAME file, with the handle closed in between.
 *
 * `phase` is `'before'` for the first run and `'after'` for the second. Nothing carries over in
 * memory, so anything still readable in `'after'` was really written to disk.
 */
function acrossRestart(body: (phase: 'before' | 'after') => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'discordbot-welcome-'));
  scratchDirs.push(dir);
  const previous = process.env['DATABASE_PATH'];
  process.env['DATABASE_PATH'] = path.join(dir, 'restart.db');

  /** One "process": a fresh handle, closed again on the way out. */
  const session = (run: () => void): void => {
    closeDatabase();
    try {
      run();
    } finally {
      closeDatabase();
    }
  };

  try {
    session(() => body('before'));
    session(() => body('after'));
  } finally {
    if (previous === undefined) {
      delete process.env['DATABASE_PATH'];
    } else {
      process.env['DATABASE_PATH'] = previous;
    }
  }
}

describe('the stored shape', () => {
  it('reads a stored flag back as a boolean, not as the integer SQLite holds', () => {
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });

    // `1 === true` is false, and `if (1)` is true by accident rather than by decision. The store
    // converts at the boundary so nothing downstream has to know SQLite has no boolean type.
    expect(getGreetingSettings(GUILD)).toEqual({ enabled: true, channelId: '200000000000000001' });
    expect(getGreetingSettings(GUILD).enabled).toBe(true);

    configureGreeting(GUILD, { enabled: false, channelId: '200000000000000001' });
    expect(getGreetingSettings(GUILD).enabled).toBe(false);
  });

  it('keeps an unset channel null rather than an empty string', () => {
    configureGreeting(GUILD, { enabled: true, channelId: null });

    // An empty string is not a channel. `isGreetingEnabled` checks for null, so storing "" would
    // either post nowhere or, worse, post to a channel whose id happens to be empty.
    expect(getGreetingSettings(GUILD)).toEqual({ enabled: true, channelId: null });
    expect(isGreetingEnabled(GUILD)).toBe(false);
  });

  it('answers the disabled default for a guild that has no row at all', () => {
    expect(getGreetingSettings('999999999999999999')).toEqual({ enabled: false, channelId: null });
  });
});

describe('surviving a restart', () => {
  it('still has the configuration after the process handle is closed and reopened', () => {
    // The point of the change: a server manager sets this once, and it is still set after a deploy.
    acrossRestart((phase) => {
      if (phase === 'before') {
        configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
        return;
      }
      expect(getGreetingSettings(GUILD)).toEqual({ enabled: true, channelId: '200000000000000001' });
      expect(isGreetingEnabled(GUILD)).toBe(true);
    });
  });

  it('still remembers a configured channel after the greeting is switched off', () => {
    acrossRestart((phase) => {
      if (phase === 'before') {
        configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
        configureGreeting(GUILD, { enabled: false, channelId: '200000000000000001' });
        return;
      }
      expect(isGreetingEnabled(GUILD)).toBe(false);
      expect(getGreetingSettings(GUILD).channelId).toBe('200000000000000001');
    });
  });
});
