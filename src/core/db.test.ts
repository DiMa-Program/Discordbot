/**
 * Tests for the SQLite layer.
 *
 * EVERY DATABASE HERE IS EITHER IN MEMORY OR IN THE OS TEMP DIRECTORY.
 *
 * Nothing in this file may create, read or delete a file in the working tree. A test that leaves a
 * `data/` directory behind is a failing test, because a green suite with a stray database is exactly
 * what a broken persistence layer looks like. The temp files that prove persistence really works
 * live under `os.tmpdir()` and are removed in `afterEach`.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyMigrations,
  ColumnMismatchError,
  closeDatabase,
  getDatabase,
  isMemoryPath,
  MEMORY_PATH,
  openDatabase,
  optionalNumber,
  optionalString,
  readDatabasePath,
  readSchemaVersion,
  requireNumber,
  requireString,
  resolveDatabasePath,
  SCHEMA_MIGRATIONS,
  SCHEMA_VERSION,
  type Database,
} from './db.js';

/** Temp directories created by this file, removed after each test. */
const scratchDirs: string[] = [];

/** A fresh temp directory outside the working tree, cleaned up when the test ends. */
function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'discordbot-db-'));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** The tables the current schema is expected to contain, one per feature. */
const EXPECTED_TABLES: readonly string[] = ['valorant_links', 'welcome_settings'];

function tableNames(db: Database): readonly string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row['name'])
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

/* -------------------------------------------------------------------------------------------- */

describe('resolveDatabasePath', () => {
  it('lands in <root>/data no matter where the module is loaded from', () => {
    // Both trees sit exactly two levels below the root, which is why one expression serves tsx,
    // vitest and a built dist/ process alike.
    const fromSource = resolveDatabasePath(pathToFileURL('C:\\repo\\src\\core\\db.ts').href);
    const fromBuild = resolveDatabasePath(pathToFileURL('C:\\repo\\dist\\core\\db.js').href);

    expect(fromSource).toBe(path.resolve('C:\\repo\\data\\bot.db'));
    expect(fromBuild).toBe(path.resolve('C:\\repo\\data\\bot.db'));
  });

  it('ignores the working directory, so a deploy started elsewhere cannot create a second database', () => {
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(resolveDatabasePath(pathToFileURL('C:\\repo\\src\\core\\db.ts').href)).toBe(
        path.resolve('C:\\repo\\data\\bot.db'),
      );
    } finally {
      process.chdir(original);
    }
  });
});

describe('readDatabasePath', () => {
  it('uses the default when the variable is unset', () => {
    expect(readDatabasePath({})).toBe(resolveDatabasePath());
  });

  it('uses DATABASE_PATH when it is set, including an explicit :memory:', () => {
    expect(readDatabasePath({ DATABASE_PATH: 'C:\\somewhere\\else.db' })).toBe('C:\\somewhere\\else.db');
    expect(readDatabasePath({ DATABASE_PATH: ':memory:' })).toBe(MEMORY_PATH);
  });

  it('treats a blank value as unset rather than as a file called nothing', () => {
    // `DATABASE_PATH=` is almost always a copy/paste that lost the value. Reading it as a filename
    // would create a file with an empty name in the root instead of quietly using the default.
    expect(readDatabasePath({ DATABASE_PATH: '' })).toBe(resolveDatabasePath());
    expect(readDatabasePath({ DATABASE_PATH: '   ' })).toBe(resolveDatabasePath());
  });
});

describe('isMemoryPath', () => {
  it('recognises the in-memory path and an empty one, and nothing else', () => {
    expect(isMemoryPath(':memory:')).toBe(true);
    expect(isMemoryPath('')).toBe(true);
    expect(isMemoryPath('data/bot.db')).toBe(false);
    expect(isMemoryPath(':memory')).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('migrations', () => {
  it('creates every table a feature owns and records the version', () => {
    const db = openDatabase({ path: MEMORY_PATH });

    expect(tableNames(db)).toEqual([...EXPECTED_TABLES]);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('is a no-op when applied twice, and reports that it did nothing', () => {
    const db = openDatabase({ path: MEMORY_PATH });

    // The second call must not throw and must not touch anything. `CREATE TABLE IF NOT EXISTS`
    // is what makes that true; a plain `CREATE TABLE` would throw "table already exists".
    expect(applyMigrations(db)).toEqual([]);
    expect(applyMigrations(db)).toEqual([]);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);

    db.close();
  });

  it('applies each migration exactly once, in version order', () => {
    const db = openDatabase({ path: MEMORY_PATH, migrations: [] });

    // An empty migration list leaves a database at version 0 with no tables at all.
    expect(readSchemaVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual([]);

    const applied = applyMigrations(db);

    expect(applied).toEqual(SCHEMA_MIGRATIONS.map((migration) => migration.version));
    expect(applied).toEqual([...applied].sort((left, right) => left - right));
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(tableNames(db)).toEqual([...EXPECTED_TABLES]);

    db.close();
  });

  it('refuses a database from a newer build rather than writing rows it would misread', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    // A downgrade that silently skips migrations would then write rows the newer schema reads
    // wrongly. Failing at boot is the only safe answer.
    expect(() => applyMigrations(db)).toThrow(/newer than this build/);

    db.close();
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('the handle', () => {
  it('round-trips a write, a read and a delete', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    const insert = db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)');

    expect(insert.run('1', 1, 'channel').changes).toBe(1);
    expect(db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('1')).toEqual({
      guild_id: '1',
      enabled: 1,
      channel_id: 'channel',
    });
    expect(db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('absent')).toBeUndefined();

    const update = db.prepare('UPDATE welcome_settings SET enabled = ? WHERE guild_id = ?');
    expect(update.run(0, '1').changes).toBe(1);
    expect(db.prepare('SELECT enabled FROM welcome_settings WHERE guild_id = ?').get('1')).toEqual({ enabled: 0 });

    expect(db.prepare('DELETE FROM welcome_settings WHERE guild_id = ?').run('1').changes).toBe(1);
    expect(db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('1')).toBeUndefined();

    db.close();
  });

  it('reports a row deleted by a statement that matched nothing as zero changes', () => {
    // `unlinkAccount` returns this number, and "there was nothing to unlink" has to be
    // distinguishable from a real unlink.
    const db = openDatabase({ path: MEMORY_PATH });

    expect(db.prepare('DELETE FROM welcome_settings WHERE guild_id = ?').run('nobody').changes).toBe(0);

    db.close();
  });

  it('stores NULL as NULL rather than as a zero or an empty string', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('1', 0, null);

    // A null read as 0 would tell a member their rank rating is zero, so this is worth pinning.
    const row = db.prepare('SELECT channel_id FROM welcome_settings WHERE guild_id = ?').get('1');
    expect(row?.['channel_id']).toBeNull();

    db.close();
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('persistence', () => {
  it('reads a value back through a SECOND handle after the first was closed', () => {
    const file = path.join(scratchDir(), 'persisted.db');

    const first = openDatabase({ path: file });
    first.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('42', 1, 'kept');
    first.close();

    // A brand new handle. Anything that only round-tripped through one live connection would pass
    // even with a persistence layer that stored nothing at all, which is the failure this catches.
    const second = openDatabase({ path: file });
    const row = second.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('42');

    expect(row).toEqual({ guild_id: '42', enabled: 1, channel_id: 'kept' });
    second.close();
  });

  it('reopens an already-migrated database without erroring and without losing data', () => {
    const file = path.join(scratchDir(), 'reopen.db');

    const first = openDatabase({ path: file });
    first.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('7', 1, null);
    first.close();

    // This is the real boot path: the file already exists, already has the schema, and starting the
    // bot again must not drop or recreate a single table.
    const second = openDatabase({ path: file });

    expect(tableNames(second)).toEqual([...EXPECTED_TABLES]);
    expect(readSchemaVersion(second)).toBe(SCHEMA_VERSION);
    expect(second.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('7')).toEqual({
      guild_id: '7',
      enabled: 1,
      channel_id: null,
    });
    second.close();
  });

  it('creates the parent directory, so a fresh clone runs with no setup step', () => {
    const nested = path.join(scratchDir(), 'deeply', 'nested', 'bot.db');
    expect(existsSync(path.dirname(nested))).toBe(false);

    const db = openDatabase({ path: nested });
    expect(existsSync(nested)).toBe(true);
    db.close();
  });

  it('never touches the filesystem for an in-memory database', () => {
    const dir = scratchDir();

    const db = openDatabase({ path: MEMORY_PATH });
    db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('1', 1, null);
    db.close();

    expect(existsSync(path.join(dir, 'bot.db'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('the process-wide handle', () => {
  it('is opened on first use and reused afterwards', () => {
    expect(getDatabase()).toBe(getDatabase());
  });

  it('is forgotten by closeDatabase, so the next call reopens', () => {
    const first = getDatabase();
    closeDatabase();

    // Forgetting without closing would hand out a handle to a closed database, and closing without
    // forgetting would never reopen. This proves the second half.
    expect(getDatabase()).not.toBe(first);
  });
});

/* -------------------------------------------------------------------------------------------- */

describe('column readers', () => {
  it('returns null for a NULL column, and never confuses it with a zero or an empty string', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('1', 0, null);
    const row = db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('1');

    expect(row).toBeDefined();
    expect(optionalString(row ?? {}, 'channel_id')).toBeNull();
    expect(optionalNumber(row ?? {}, 'channel_id')).toBeNull();
    // A column that is not in the row at all reads the same way, because SQLite omits nothing.
    expect(optionalString(row ?? {}, 'no_such_column')).toBeNull();

    db.close();
  });

  it('reads a present number and a present string', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('1', 1, 'c');
    const row = db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('1') ?? {};

    expect(requireNumber(row, 'welcome_settings', 'enabled')).toBe(1);
    expect(requireString(row, 'welcome_settings', 'channel_id')).toBe('c');
    expect(optionalNumber(row, 'enabled')).toBe(1);
    expect(optionalString(row, 'channel_id')).toBe('c');

    db.close();
  });

  it('throws for a required column that is missing, naming the column and never the row', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    const row = db.prepare('SELECT guild_id FROM welcome_settings').all();

    // A row that does not match the schema means every answer built on it would be wrong. A row
    // holds a Riot ID in the ranks feature, so the message names the column and nothing else.
    expect(() => requireString(row[0] ?? {}, 'welcome_settings', 'channel_id')).toThrow(ColumnMismatchError);
    expect(() => requireString(row[0] ?? {}, 'welcome_settings', 'channel_id')).toThrow(
      /Column "channel_id" of "welcome_settings"/,
    );

    db.close();
  });

  it('rejects a NULL in a required column rather than coercing it', () => {
    const db = openDatabase({ path: MEMORY_PATH });
    db.prepare('INSERT INTO welcome_settings (guild_id, enabled, channel_id) VALUES (?, ?, ?)').run('1', 0, null);
    const row = db.prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get('1') ?? {};

    expect(() => requireString(row, 'welcome_settings', 'channel_id')).toThrow(ColumnMismatchError);

    db.close();
  });
});
