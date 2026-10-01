/**
 * SQLite access — the only module in the project that imports `node:sqlite`.
 *
 * WHY THE BUILT-IN, AND NOT A PACKAGE.
 *
 * `node:sqlite` ships with Node, so persistence costs zero dependencies: no `better-sqlite3`, no
 * native build step, nothing to audit or keep in step with Node's release cycle. The whole surface
 * this project needs is `exec`, `prepare` and `close`, and `src/core/db.ts` is the only file that
 * knows the import exists. Everything above it depends on the `Database` interface declared here,
 * so if the built-in API changes or graduates to stable under a different name, this is one file.
 *
 * WHY IT IS SYNCHRONOUS, AND WHY THAT IS THE POINT.
 *
 * Every call here blocks. That is not an oversight to be pooled away: Node runs JavaScript on one
 * thread, so a synchronous driver has no interleaving with the Discord gateway and no second
 * writer to race against. The ranks feature's two maps had no locking because nothing could
 * interleave; this has the same property, and now it is also true across process restarts.
 *
 * THE HANDLE IS AN INTERFACE, NOT A TYPE ALIAS.
 *
 * `Database` and `Statement` are declared here rather than imported from `node:sqlite`, so feature
 * code depends on this contract and not on the driver. That is what keeps the swap honest: nothing
 * outside this file names `DatabaseSync`.
 *
 * NOTHING LOGS ROW CONTENTS. A row holds a Riot ID, and the rank provider's terms require
 * consent-scoped handling of exactly that, so this module has no logger at all and its errors name
 * columns rather than values. There is deliberately nothing here to add a `log.debug(row)` to.
 *
 * SCHEMA OWNERSHIP, AND WHY THE MIGRATIONS LIVE HERE.
 *
 * Each feature owns its own tables, its own queries and its own row mappers: the two tables in
 * `src/features/ranks/` belong to `store.ts` and `welcome_settings` to
 * `src/features/welcome/greeting-store.ts`. The DDL sits here because the ordered, versioned list
 * is a property of the DATABASE, not of any one feature: migrations have to run in sequence before
 * a single feature is loaded, and the registry deliberately forbids `core/` importing a feature by
 * name. Letting each feature export its own migration would make the resulting schema depend on
 * folder-scan order, which is not a property anyone should have to reason about. The alternative —
 * a registration call per feature at import time — trades a deterministic list for one that
 * silently changes when a folder is renamed.
 *
 * MIGRATIONS ARE IDEMPOTENT AND VERSIONED. `PRAGMA user_version` is the schema version; each
 * migration runs once, inside a transaction that also bumps the version, and every statement is
 * written to be safe against a database that already exists (`IF NOT EXISTS`). Nothing is dropped or
 * recreated on boot, so a member's link is never destroyed by starting the bot.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

/* -------------------------------------------------------------------------------------------- */
/* The handle                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * A value SQLite can hold.
 *
 * Deliberately narrower than `node:sqlite`'s own `SQLOutputValue`, which also admits a BLOB. This
 * project stores TEXT, INTEGER and NULL, and the mapping in `toRow` rejects a BLOB rather than
 * widening every row type to include one no table can produce.
 */
export type SqlValue = null | number | bigint | string;

/**
 * One row, as a plain object.
 *
 * `node:sqlite` returns a `Record` keyed by column name. The feature row mappers read named columns
 * out of it and produce their own domain types, so no feature ever sees this type directly.
 */
export type SqlRow = Readonly<Record<string, SqlValue>>;

/** What `run` reports back. `changes` is how many rows the statement actually affected. */
export interface RunResult {
  readonly changes: number;
}

/** A prepared statement. The only three verbs the project needs. */
export interface Statement {
  /** Executes a write and reports how many rows it changed. */
  run(...params: readonly SqlValue[]): RunResult;
  /** The first matching row, or `undefined` when nothing matched. */
  get(...params: readonly SqlValue[]): SqlRow | undefined;
  /** Every matching row, possibly none. */
  all(...params: readonly SqlValue[]): readonly SqlRow[];
}

/** An open database. Three methods, on purpose. */
export interface Database {
  /** Runs one or more statements with no result rows. Used for DDL and pragmas. */
  exec(sql: string): void;
  /** Compiles a statement for repeated execution. */
  prepare(sql: string): Statement;
  /** Closes the handle. Using a closed handle throws. */
  close(): void;
}

/* -------------------------------------------------------------------------------------------- */
/* Reading columns                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * A row does not match the schema the code was written against.
 *
 * The only realistic cause is a column that was renamed or dropped by a migration that this build
 * does not know about. It is thrown, not returned, because every answer built on a half-read row
 * would be a wrong answer shown to a member as fact.
 *
 * THE MESSAGE NAMES THE COLUMN AND NEVER THE VALUE. A row holds a Riot ID, and this is the module
 * the privacy rule is enforced in.
 */
export class ColumnMismatchError extends Error {
  constructor(table: string, column: string, expected: string) {
    super(`Column "${column}" of "${table}" is missing or is not ${expected}.`);
    this.name = new.target.name;
  }
}

/** A required column that must hold text. */
export function requireString(row: SqlRow, table: string, column: string): string {
  const value = row[column];
  if (typeof value === 'string') {
    return value;
  }
  throw new ColumnMismatchError(table, column, 'text');
}

/** A required column that must hold an integer, whatever width the driver handed back. */
export function requireNumber(row: SqlRow, table: string, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new ColumnMismatchError(table, column, 'an integer');
}

/**
 * A column that is allowed to be absent, which is how a nullable rank column reads back.
 *
 * SQLite stores `NULL` as `NULL` and never as a missing key, so "absent" and "null" are the same
 * answer here — and conflating them is exactly the mistake a nullable rank column invites, because
 * a `null` read as `0` would tell a member their rank rating is zero.
 */
export function optionalString(row: SqlRow, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

/** The nullable-number counterpart of `optionalString`. */
export function optionalNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return null;
}

/* -------------------------------------------------------------------------------------------- */
/* Path resolution                                                                                */
/* -------------------------------------------------------------------------------------------- */

/** Environment variable that overrides where the database file lives. */
export const DATABASE_PATH_ENV = 'DATABASE_PATH';

/** The path that means "do not touch the filesystem at all". Used by every test. */
export const MEMORY_PATH = ':memory:';

/**
 * Absolute path of the database file, resolved from this module's own location.
 *
 * NOT `process.cwd()`. The working directory is whatever the operator happened to run `npm run dev`
 * from — the repo root today, but a systemd unit or a PM2 config can and does differ — and a
 * process that silently creates a second, empty database in an unexpected directory loses every
 * link on the next restart. Resolving from `import.meta.url` gives the same answer under `tsx`
 * (`src/core` → `<root>/data`), under vitest, and from a built process (`dist/core` → `<root>/data`),
 * because both trees sit exactly two levels below the root. This is the rule `resolveFeaturesDir`
 * in `registry.ts` already established, and it exists for the same reason.
 */
export function resolveDatabasePath(metaUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', '..', 'data', 'bot.db');
}

/** Whether a path asks for a private in-memory database rather than a file. */
export function isMemoryPath(databasePath: string): boolean {
  return databasePath === MEMORY_PATH || databasePath === '';
}

/**
 * The path to open: an explicit `DATABASE_PATH` when set, otherwise the default.
 *
 * The env var is read per call rather than memoized, so a test can point the process at `:memory:`
 * and get what it asked for. An empty value is treated as "unset" instead of as a filename, which
 * is the only reading of `DATABASE_PATH=` that cannot produce a file called nothing.
 */
export function readDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DATABASE_PATH_ENV];
  return configured === undefined || configured.trim() === '' ? resolveDatabasePath() : configured.trim();
}

/* -------------------------------------------------------------------------------------------- */
/* Migrations                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/** One ordered, versioned schema change. */
export interface Migration {
  /** Applied in ascending order, and recorded in `PRAGMA user_version` once it succeeds. */
  readonly version: number;
  /** What the migration does, for the boot log and for whoever reads this file next. */
  readonly name: string;
  /** Statements that must all succeed. Written to be safe against a database that already exists. */
  readonly sql: string;
}

/**
 * The schema, in order.
 *
 * ONE TABLE PER STORED THING, ONE MIGRATION PER TABLE, and a new table is always a NEW version at
 * the end — never an edit to an existing entry. Renumbering an applied migration is how a deployed
 * database ends up with a schema that no longer matches its own version marker.
 *
 * `valorant_links` — owned by `src/features/ranks/store.ts`.
 *
 * The link columns and the rank columns are INDEPENDENTLY NULLABLE, and that is not sloppiness: it
 * is what lets `cacheRank` store a rank for a user the store has not been told the link of. The two
 * sets are all-or-nothing separately (enforced by the CHECK constraints) because a half-written
 * link or a half-written rank would read back as a real value and be served to a member.
 *
 * `tier_name` is stored and `tier` is NOT. The tier is derived from the stored name through the
 * same `findTierByName` the provider uses, so the two can never disagree and a catalog change is
 * picked up by ranks that are already cached instead of being frozen into a column that would then
 * need its own migration.
 *
 * `welcome_settings` — owned by `src/features/welcome/greeting-store.ts`.
 *
 * `enabled` is an INTEGER because SQLite has no boolean type, and the feature's row mapper turns it
 * back into a real `boolean` at the boundary. `channel_id` is nullable because "enabled with no
 * channel yet" is a state the command produces and the handler has to recognise.
 *
 * `valorant_prompt_decisions` — also owned by `src/features/ranks/store.ts`, and the reason "one
 * table per feature" is really "one table per stored thing".
 *
 * A SECOND TABLE FOR THE SAME FEATURE, ON PURPOSE. The obvious move was a nullable column beside
 * the link columns, and SQLite refuses it in the only shape that is safe to run against a deployed
 * database: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` does not exist, so the alternatives are a
 * migration whose idempotency rests entirely on the version marker, or a rebuild-and-copy of a
 * table holding every member's Riot ID. A new table is neither, and it is the better model on its
 * own terms: a declined member has a decision and NO link, while `unlinkAccount` deletes an entire
 * `valorant_links` row — so a decision kept there would either vanish on unlink, or re-ask somebody
 * who deliberately left. Consent answers and account data have different lifetimes, and now they
 * have different tables.
 *
 * `prompt_decision` is TEXT FROM A CLOSED UNION, enforced by the database rather than trusted from
 * the writer, and `decided_at` is tied to it by a CHECK exactly as `tier_name` is tied to
 * `rank_fetched_at` above: "never asked" and "answered but not stamped" must not be able to
 * disagree, and a CHECK is cheaper than remembering to keep two columns in step.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'ranks-valorant-links',
    sql: `
      CREATE TABLE IF NOT EXISTS valorant_links (
        user_id             TEXT    PRIMARY KEY,
        riot_name           TEXT,
        riot_tag            TEXT,
        linked_at           INTEGER,
        rank_riot_id        TEXT,
        rank_account_name   TEXT,
        rank_account_tag    TEXT,
        rank_platform       TEXT,
        region              TEXT,
        inferred_region     TEXT,
        tier_name           TEXT,
        rank_rating         INTEGER,
        estimated_elo       INTEGER,
        games_needed        INTEGER,
        last_change         INTEGER,
        rank_fetched_at     INTEGER,
        CHECK (
          (riot_name IS NULL AND riot_tag IS NULL AND linked_at IS NULL)
          OR (riot_name IS NOT NULL AND riot_tag IS NOT NULL AND linked_at IS NOT NULL)
        ),
        CHECK ((rank_fetched_at IS NULL) = (tier_name IS NULL))
      );
    `,
  },
  {
    version: 2,
    name: 'welcome-settings',
    sql: `
      CREATE TABLE IF NOT EXISTS welcome_settings (
        guild_id    TEXT    PRIMARY KEY,
        enabled     INTEGER NOT NULL,
        channel_id  TEXT
      );
    `,
  },
  {
    version: 3,
    name: 'ranks-prompt-decisions',
    sql: `
      CREATE TABLE IF NOT EXISTS valorant_prompt_decisions (
        user_id         TEXT PRIMARY KEY,
        prompt_decision TEXT,
        decided_at      INTEGER,
        CHECK (prompt_decision IS NULL OR prompt_decision IN ('accepted', 'declined')),
        CHECK ((decided_at IS NULL) = (prompt_decision IS NULL))
      );
    `,
  },
];

/** The schema this build expects, in order. Exported so tests can reason about the version count. */
export const SCHEMA_MIGRATIONS: readonly Migration[] = MIGRATIONS;

/** The highest version the schema defines, which is what a fully migrated database reports. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/**
 * The database's recorded schema version.
 *
 * `PRAGMA user_version` is a single integer that SQLite stores in the file header. It is used here
 * rather than a `migrations` table because it cannot drift out of step with the schema it
 * describes: there is no second table to forget to update.
 */
export function readSchemaVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row?.['user_version'];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return 0;
}

/**
 * Applies every migration newer than the database's recorded version.
 *
 * IDEMPOTENT BY CONSTRUCTION: a migration below the current version is skipped, so running this on
 * an already-migrated database does nothing at all. Each migration is applied together with its
 * version bump inside one transaction, which means a crash midway leaves the version where it was
 * and the migration simply runs again on the next boot rather than half-applying forever.
 *
 * @returns the versions applied by THIS call, in order. Empty means the database was already current.
 * @throws when the database is at a version this build does not know about, which happens when the
 *         bot is downgraded. Failing loudly beats a downgrade that silently ignores a migration and
 *         then writes rows the newer schema would read wrongly.
 */
export function applyMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): readonly number[] {
  const current = readSchemaVersion(db);
  const known = new Set(migrations.map((migration) => migration.version));

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build understands (${SCHEMA_VERSION}). ` +
        'Upgrade the bot, or point DATABASE_PATH at a different file.',
    );
  }

  const pending = migrations.filter((migration) => migration.version > current).sort(byVersion);
  const applied: number[] = [];

  for (const migration of pending) {
    if (!known.has(migration.version)) {
      throw new Error(`Migration ${migration.version} (${migration.name}) is not part of the known set.`);
    }
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
  }

  return applied;
}

function byVersion(left: Migration, right: Migration): number {
  return left.version - right.version;
}

/* -------------------------------------------------------------------------------------------- */
/* Opening                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** How to open a database. Every field is optional, and the defaults are the production path. */
export interface OpenDatabaseOptions {
  /** File path, or `:memory:`. Defaults to `DATABASE_PATH`, then to `<root>/data/bot.db`. */
  readonly path?: string;
  /** Where to read `DATABASE_PATH` from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Migrations to apply. Defaults to this build's schema. */
  readonly migrations?: readonly Migration[];
}

/**
 * Opens a database, creates its directory, and brings its schema up to date.
 *
 * THE PARENT DIRECTORY IS CREATED, so a fresh clone runs with no setup step. The alternative — a
 * `mkdir` in the README that everyone forgets on their first deploy — trades one line of code for a
 * support question. A missing parent directory is the single most common way a first run of any
 * database-backed app fails.
 *
 * WAL is enabled for crash safety: it lets a reader run while a writer commits, and it means an
 * interrupted write leaves the previous state intact rather than a corrupt file. On `:memory:` the
 * pragma is a no-op that reports `memory`, which is correct and costs nothing.
 */
export function openDatabase(options: OpenDatabaseOptions = {}): Database {
  const databasePath = options.path ?? readDatabasePath(options.env ?? process.env);

  if (!isMemoryPath(databasePath)) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const handle = new DatabaseSync(databasePath);
  handle.exec('PRAGMA journal_mode = WAL');
  const db = wrap(handle);

  try {
    applyMigrations(db, options.migrations ?? MIGRATIONS);
  } catch (error) {
    // A half-open handle would keep a file lock on a database the process cannot use.
    db.close();
    throw error;
  }

  return db;
}

/* -------------------------------------------------------------------------------------------- */
/* The process-wide handle                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * The handle features use when they are not given one.
 *
 * Opened on FIRST USE, not at import time, for the reason `ranks/context.ts` gives for the provider
 * key: a unit test imports the store directly with no `.env` and no database anywhere near it, and
 * an import-time open would create a file as a side effect of importing a module. The vitest setup
 * file points `DATABASE_PATH` at `:memory:` so the lazy path in a test run is an in-memory database.
 *
 * Memoized for the process. There is no reason to reopen: the point of the file is to be the same
 * database every time.
 */
let processHandle: Database | null = null;

/** The shared handle, opened on first use. */
export function getDatabase(): Database {
  if (processHandle === null) {
    processHandle = openDatabase();
  }
  return processHandle;
}

/**
 * Closes the shared handle and forgets it, so the next call opens a fresh one.
 *
 * Closing without forgetting would hand every later caller a handle to a closed database, and
 * forgetting without closing would leak a file lock. This is also what makes it possible to test
 * persistence honestly: write, close, reopen, read.
 */
export function closeDatabase(): void {
  if (processHandle === null) {
    return;
  }
  const handle = processHandle;
  processHandle = null;
  handle.close();
}

/* -------------------------------------------------------------------------------------------- */
/* The adapter                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** Narrows one driver value to this project's value set, or explains why it cannot. */
function toValue(column: string, value: SQLOutputValue): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  throw new TypeError(
    `Column "${column}" holds a BLOB. This project stores TEXT and INTEGER; read it explicitly ` +
      'instead of widening the row type to admit one.',
  );
}

/**
 * Copies a driver row into the project's row shape.
 *
 * A real runtime narrowing rather than a cast: the cast would be a lie the moment a table grew a
 * BLOB column, and this is the single place that has to notice. It runs once per row on TEXT and
 * INTEGER values, which is nothing at this scale.
 */
function toRow(row: Record<string, SQLOutputValue>): SqlRow {
  const mapped: Record<string, SqlValue> = {};
  for (const [column, value] of Object.entries(row)) {
    mapped[column] = toValue(column, value);
  }
  return mapped;
}

/** Narrows a bindable value, rejecting the BLOB shapes this project never writes. */
function toInput(value: SqlValue): SQLInputValue {
  return value;
}

/** Adapts one driver statement. Normalises the loose driver types into the declared interface. */
function wrapStatement(statement: {
  run(...params: SQLInputValue[]): { changes: number | bigint };
  get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
  all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
}): Statement {
  return {
    run(...params: readonly SqlValue[]): RunResult {
      const result = statement.run(...params.map(toInput));
      return { changes: Number(result.changes) };
    },
    get(...params: readonly SqlValue[]): SqlRow | undefined {
      const row = statement.get(...params.map(toInput));
      return row === undefined ? undefined : toRow(row);
    },
    all(...params: readonly SqlValue[]): readonly SqlRow[] {
      return statement.all(...params.map(toInput)).map(toRow);
    },
  };
}

/**
 * Adapts a `DatabaseSync` to the `Database` interface.
 *
 * From here down, the project depends on `Database` and `Statement` and not on `node:sqlite`. The
 * three driver methods are forwarded as they are, with no caching of prepared statements: the
 * workload is a handful of single-row reads and writes per interaction, and a statement cache would
 * be a second lifetime to reason about for no measurable gain.
 */
function wrap(handle: DatabaseSync): Database {
  return {
    exec: (sql: string): void => handle.exec(sql),
    prepare: (sql: string): Statement => wrapStatement(handle.prepare(sql)),
    close: (): void => handle.close(),
  };
}
