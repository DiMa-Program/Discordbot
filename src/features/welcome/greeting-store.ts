/**
 * Per-guild greeting settings, persisted in SQLite.
 *
 * DISABLED BY DEFAULT, and still is. A reference feature must not start posting in servers it was
 * merely installed into, so a guild has to opt in through `/config-greeting` before anything is
 * sent. What changed is that the opt-in now survives a restart, which is what makes it a setting
 * rather than a toggle somebody has to flip after every deploy.
 *
 * The public API is unchanged and still synchronous: every caller already had a synchronous
 * `Map.get`, and a synchronous database read is the same cost.
 *
 * `enabled` is stored as an INTEGER because SQLite has no boolean type, and it is turned back into
 * a real `boolean` at the boundary. That conversion is the reason this file has a row mapper at
 * all: a stored `1` reaching `isGreetingEnabled` would be truthy by accident rather than by
 * decision, and the same `1` compared with `=== true` would be false.
 */

import { getDatabase, optionalString, requireNumber, type Database, type SqlRow } from '../../core/db.js';

/** The table this feature owns. */
const TABLE = 'welcome_settings';

/** SQLite's stand-in for `false`, named so the intent is visible at the call site. */
const DISABLED_FLAG = 0;

/** SQLite's stand-in for `true`. */
const ENABLED_FLAG = 1;

export interface GreetingSettings {
  readonly enabled: boolean;
  /** Channel the greeting is posted to, or `null` while unset. */
  readonly channelId: string | null;
}

const DISABLED: GreetingSettings = { enabled: false, channelId: null };

/* -------------------------------------------------------------------------------------------- */
/* Statements                                                                                     */
/* -------------------------------------------------------------------------------------------- */

const SELECT_ALL = `SELECT * FROM ${TABLE} WHERE guild_id = ?`;

const UPSERT = `
  INSERT INTO ${TABLE} (guild_id, enabled, channel_id)
  VALUES (?, ?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET
    enabled = excluded.enabled,
    channel_id = excluded.channel_id
`;

const DELETE_ALL = `DELETE FROM ${TABLE}`;

/* -------------------------------------------------------------------------------------------- */
/* Row mapping                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Turns a stored row into the feature's own shape.
 *
 * `enabled` comes back as a genuine boolean and `channelId` as a genuine `string | null`, so
 * nothing downstream has to know SQLite exists. The `enabled` value is compared to the stored flag
 * rather than cast: an unrecognised integer is treated as "off", because a greeting that should
 * not have been sent is the cheaper mistake.
 */
function toSettings(row: SqlRow): GreetingSettings {
  return {
    enabled: requireNumber(row, TABLE, 'enabled') === ENABLED_FLAG,
    channelId: optionalString(row, 'channel_id'),
  };
}

/** A `boolean` for a column that stores one. Kept next to the mapper that consumes it. */
function toFlag(enabled: boolean): number {
  return enabled ? ENABLED_FLAG : DISABLED_FLAG;
}

/* -------------------------------------------------------------------------------------------- */
/* The store                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** Current settings for a guild, defaulting to disabled with no channel. */
export function getGreetingSettings(guildId: string): GreetingSettings {
  const row = database().prepare(SELECT_ALL).get(guildId);
  return row === undefined ? DISABLED : toSettings(row);
}

/**
 * Whether a greeting should actually be sent.
 *
 * Requires both the flag and a target channel, so enabling the feature without configuring a
 * channel cannot produce a greeting with nowhere to go.
 */
export function isGreetingEnabled(guildId: string): boolean {
  const settings = getGreetingSettings(guildId);
  return settings.enabled && settings.channelId !== null;
}

/** Replaces a guild's settings and returns the stored value. */
export function configureGreeting(
  guildId: string,
  settings: { readonly enabled: boolean; readonly channelId: string | null },
): GreetingSettings {
  database().prepare(UPSERT).run(guildId, toFlag(settings.enabled), settings.channelId);
  return { enabled: settings.enabled, channelId: settings.channelId };
}

/**
 * Clears all state.
 *
 * Test-only, and NOT what a restart does any more. Nothing in the running bot calls it, and that
 * is deliberate: dropping every server's configuration is not a thing a command should be able to do.
 */
export function resetGreetingSettings(): void {
  database().prepare(DELETE_ALL).run();
}

/**
 * Resolves the handle on every call.
 *
 * Not captured in module scope: a module-scoped handle is opened at import time, which would create
 * a database file as a side effect of importing this module, and it would keep talking to a closed
 * handle after a test swaps the process-wide one.
 */
function database(): Database {
  return getDatabase();
}
