/**
 * Linked Riot IDs and the cached rank, persisted in SQLite.
 *
 * DURABLE NOW. This used to be two module-scoped `Map`s, which meant a restart, a redeploy or a
 * crash lost every link and every member had to link again — a limitation that was accepted while
 * the feature was young and then bit in production. The public API below is deliberately IDENTICAL
 * to the in-memory version, so `interaction.ts`, the commands and the role sync needed no changes
 * at all: only the internals moved. That is what keeps the diff honest and what keeps the existing
 * tests meaningful.
 *
 * THE PUBLIC API IS A MAP'S API, AND THAT IS A DELIBERATE CONSTRAINT.
 *
 * Every function here is synchronous and takes a bare `userId`, because that is what its callers
 * already do. Wrapping the database in promises would push `await` through the whole ranks feature
 * to buy nothing: `node:sqlite` is synchronous, so a read is as cheap as the `Map.get` it replaced.
 *
 * KEYED BY USER, NOT BY SERVER. A Discord account links one Riot ID and that link is honoured in
 * every server the bot is in. The alternative — one link per server — would make a member relink
 * in each server for no benefit, since the Riot ID is a property of the person, not of the guild.
 * Rank ROLES are still per-server, because that is where Discord roles live.
 *
 * WHAT IS STORED: the Riot ID and when it was linked, plus the last rank read for that account and
 * when it was read. Nothing else. The provider's terms require explicit per-user consent for a
 * lookup, and that consent is captured by the link flow itself, which is why a Riot ID is only ever
 * written from inside the modal submit handler.
 *
 * ONE ROW PER USER, AND THE LINK AND THE RANK ARE INDEPENDENTLY NULLABLE. They are stored in the
 * same row because they share a key and a lifetime, but they are separate sets of columns and each
 * is all-or-nothing (enforced by CHECK constraints in `core/db.ts`). "Linked, no rank yet" is a
 * normal state, not an error: a link is only written after a successful lookup, and a provider blip
 * must not erase a link that is perfectly good.
 *
 * THE CACHED RANK IS DERIVED DATA IN ONE COLUMN AND A RECOMPUTED VALUE IN THE OTHER. `tier_name` is
 * stored; `tier` is looked up from the catalog on every read. Storing the resolved tier as well
 * would be a second copy of something the catalog already owns, free to drift the first time a
 * colour is corrected.
 *
 * NOTHING HERE LOGS. A row holds a Riot ID; the store returns rows to the caller that asked for them
 * and has no logger to leak them to.
 *
 * TWO TABLES, NOT ONE. `valorant_links` holds account data and this module also owns
 * `valorant_prompt_decisions`, which holds only the member's answer to the one-time join prompt. See
 * `PROMPT_TABLE` and the migration comment in `core/db.ts` for why the decision is not a column
 * beside the link: a decline outlives the absence of a link, and an unlink deletes a whole row.
 */

import {
  optionalNumber,
  optionalString,
  requireNumber,
  requireString,
  type Database,
  type SqlRow,
} from '../../core/db.js';
import { getDatabase } from '../../core/db.js';
import { isAffinity, resolvePlatform, type Affinity, type Platform } from './regions.js';
import { findTierByName } from './tiers.js';
import { RANK_CACHE_TTL_MS, type RankSnapshot } from './provider.js';

/** The table this feature owns for links and cached ranks. */
const TABLE = 'valorant_links';

/**
 * The second table this feature owns, holding the join-prompt answer.
 *
 * Separate from `valorant_links` because a decision outlives a link in both directions: a member who
 * declined has a decision and no link, and a member who unlinked has a link row of nothing but a
 * decision left behind it. See the migration's comment in `core/db.ts` for why it is not a column.
 */
const PROMPT_TABLE = 'valorant_prompt_decisions';

/** A Riot ID a member has explicitly linked. */
export interface LinkedAccount {
  readonly name: string;
  readonly tag: string;
  /** Discord snowflake of the user that linked it. */
  readonly userId: string;
  /** Epoch milliseconds when the link was made, for display and for diagnosing stale state. */
  readonly linkedAt: number;
}

/** The last rank the provider returned for a linked account, and the moment it returned it. */
export interface CachedRank {
  readonly snapshot: RankSnapshot;
  /** Epoch milliseconds when this snapshot was fetched, which is what the cache window is measured from. */
  readonly fetchedAt: number;
}

/**
 * What a member answered when the bot asked, on join, whether it should track a rank role for them.
 *
 * A CLOSED UNION, and `null` rather than `'undecided'` for "never asked": three states need three
 * spellings, and a member who has never been asked is materially different from one who said no.
 * Collapsing the second into the third is how a prompt ends up asking twice.
 *
 * This is NOT the consent to look a rank up. That remains the link itself, because "yes, give me a
 * rank role" is not "here is my Riot ID, read it". The value here only ever suppresses a question.
 */
export type PromptDecision = 'accepted' | 'declined';

/** Every value `PromptDecision` admits, so the reader and the table cannot disagree. */
export const PROMPT_DECISIONS: readonly PromptDecision[] = ['accepted', 'declined'];

/* -------------------------------------------------------------------------------------------- */
/* Statements                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every rank column, in the order `INSERT` below binds them.
 *
 * Written as a list rather than repeated by hand so the statement and the mapper cannot drift: a
 * column added to one and forgotten in the other is the bug this list exists to make impossible.
 */
const RANK_COLUMNS = [
  'rank_riot_id',
  'rank_account_name',
  'rank_account_tag',
  'rank_platform',
  'region',
  'inferred_region',
  'tier_name',
  'rank_rating',
  'estimated_elo',
  'games_needed',
  'last_change',
  'rank_fetched_at',
] as const;

/**
 * One `?` per rank column, derived from the list itself.
 *
 * Counting the placeholders by hand is how the statement below once bound column NAMES into the
 * `VALUES` clause and failed at prepare time with "no such column". Generating both from one list
 * makes the two impossible to disagree.
 */
const RANK_PLACEHOLDERS = RANK_COLUMNS.map(() => '?').join(', ');

const SELECT_ALL = `SELECT * FROM ${TABLE} WHERE user_id = ?`;

/**
 * Every linked row, in a stable order.
 *
 * `ORDER BY user_id` rather than insertion order because the periodic sync turns this list into a
 * work queue: a list whose order changes between two reads would make "was this member already done
 * in this pass" depend on the database's mood instead of on the account.
 */
const SELECT_LINKED = `
  SELECT * FROM ${TABLE}
  WHERE riot_name IS NOT NULL
  ORDER BY user_id
`;

/**
 * Writes a link and drops any rank cached under the previous Riot ID — in ONE statement.
 *
 * The two cannot come apart, and that is the reason this is a single upsert rather than an update
 * followed by a delete. A rank cached under the previous Riot ID describes a different account, so
 * serving it after a relink would tell someone their own rank belongs to a stranger. Between two
 * statements there is a window where the link is new and the rank is stale; there is no such window
 * here, because there is only one statement.
 */
const UPSERT_LINK = `
  INSERT INTO ${TABLE} (user_id, riot_name, riot_tag, linked_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    riot_name = excluded.riot_name,
    riot_tag = excluded.riot_tag,
    linked_at = excluded.linked_at,
    ${RANK_COLUMNS.map((column) => `${column} = NULL`).join(',\n    ')}
`;

/**
 * Writes a cached rank, leaving the link columns untouched.
 *
 * `ON CONFLICT DO UPDATE` on the rank columns only, which is what lets `cacheRank` work for a user
 * the store has no link for. The link flow calls `linkAccount` and then `cacheRank`, so by the time
 * a real member's rank is cached the link is already there.
 */
const UPSERT_RANK = `
  INSERT INTO ${TABLE} (user_id, ${RANK_COLUMNS.join(', ')})
  VALUES (?, ${RANK_PLACEHOLDERS})
  ON CONFLICT(user_id) DO UPDATE SET
    ${RANK_COLUMNS.map((column) => `${column} = excluded.${column}`).join(',\n    ')}
`;

/** Deletes the link and any cached rank together, for the same reason `UPSERT_LINK` does. */
const DELETE_LINK = `DELETE FROM ${TABLE} WHERE user_id = ?`;

const COUNT_LINKS = `SELECT COUNT(*) AS total FROM ${TABLE} WHERE riot_name IS NOT NULL`;

const DELETE_ALL = `DELETE FROM ${TABLE}`;

/** Reads the decision alone, so a caller never pays for the wide `SELECT *` on the join path. */
const SELECT_PROMPT_DECISION = `SELECT prompt_decision FROM ${PROMPT_TABLE} WHERE user_id = ?`;

/**
 * Writes the answer and its timestamp in one statement, for the same reason `UPSERT_LINK` is one
 * statement: a decision with no timestamp is not a state anything is allowed to observe.
 */
const UPSERT_PROMPT_DECISION = `
  INSERT INTO ${PROMPT_TABLE} (user_id, prompt_decision, decided_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    prompt_decision = excluded.prompt_decision,
    decided_at = excluded.decided_at
`;

const DELETE_ALL_PROMPT_DECISIONS = `DELETE FROM ${PROMPT_TABLE}`;

/* -------------------------------------------------------------------------------------------- */
/* Row mapping                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * The stored rank, or `null` when the row holds no rank.
 *
 * `rank_fetched_at` is the gate. The CHECK constraint keeps it and `tier_name` in step, so "no
 * timestamp" means "no rank" with no second condition to keep in sync.
 */
function toCachedRank(row: SqlRow): CachedRank | null {
  const fetchedAt = optionalNumber(row, 'rank_fetched_at');
  const tierName = optionalString(row, 'tier_name');
  if (fetchedAt === null || tierName === null) {
    return null;
  }
  return { snapshot: toSnapshot(row, tierName), fetchedAt };
}

/**
 * Rebuilds the whole snapshot from its columns.
 *
 * The account name and tag are stored separately from the link's name and tag because the provider
 * reports the account's own spelling, which is not always the spelling the member typed. Collapsing
 * them would overwrite one with the other the first time a player used different capitalisation.
 */
function toSnapshot(row: SqlRow, tierName: string): RankSnapshot {
  return {
    riotId: requireString(row, TABLE, 'rank_riot_id'),
    name: requireString(row, TABLE, 'rank_account_name'),
    tag: requireString(row, TABLE, 'rank_account_tag'),
    platform: toPlatform(optionalString(row, 'rank_platform')),
    affinity: toAffinity(optionalString(row, 'region'), 'region'),
    inferredAffinity: toOptionalAffinity(optionalString(row, 'inferred_region')),
    tierName,
    // Derived, never stored: the catalog is the single place a tier is identified, exactly as the
    // provider does it, so a cached rank cannot disagree with the ladder.
    tier: findTierByName(tierName),
    rankRating: optionalNumber(row, 'rank_rating'),
    estimatedElo: optionalNumber(row, 'estimated_elo'),
    gamesNeededForRating: optionalNumber(row, 'games_needed'),
    lastChange: optionalNumber(row, 'last_change'),
  };
}

/** The stored link, or `null` when the row holds no link. */
function toLinkedAccount(row: SqlRow): LinkedAccount | null {
  const name = optionalString(row, 'riot_name');
  const tag = optionalString(row, 'riot_tag');
  const linkedAt = optionalNumber(row, 'linked_at');
  if (name === null || tag === null || linkedAt === null) {
    return null;
  }
  return { name, tag, userId: requireString(row, TABLE, 'user_id'), linkedAt };
}

/**
 * Narrows a stored answer to the closed union, treating "no row" as "never asked".
 *
 * A row exists only after an answer, so the value is either one of the two literals or the column
 * is NULL. `null` means "never asked", which is the answer the join prompt needs.
 *
 * @throws {TypeError} on a decision this build does not know. The table CHECKs the same union, so
 *         reaching here means the store and the schema have diverged, and answering anyway would
 *         mean asking again somebody who already said no.
 */
function toPromptDecision(value: string | null): PromptDecision | null {
  if (value === null) {
    return null;
  }
  if (value === 'accepted' || value === 'declined') {
    return value;
  }
  throw new TypeError('Stored value for "prompt_decision" is not a known decision.');
}

/**
 * Narrows a stored region to the closed affinity union.
 *
 * @throws {TypeError} on a region this build does not know. A row naming a shard outside the union
 *         means the store and the region list have diverged, and answering it anyway would send a
 *         value the provider rejects with error code 6.
 */
function toAffinity(value: string | null, column: string): Affinity {
  if (value !== null && isAffinity(value)) {
    return value;
  }
  throw new TypeError(`Stored value for "${column}" is not a known affinity.`);
}

/** The nullable-region counterpart: "the tag pointed nowhere" is a real answer, not a failure. */
function toOptionalAffinity(value: string | null): Affinity | null {
  return value !== null && isAffinity(value) ? value : null;
}

/**
 * Narrows a stored platform, defaulting the way the provider does.
 *
 * `resolvePlatform` is the provider's own rule, reused rather than reimplemented: a row can only
 * hold what a provider wrote, and one unreadable value should not take the whole rank view down.
 */
function toPlatform(value: string | null): Platform {
  return resolvePlatform(value ?? undefined);
}

/* -------------------------------------------------------------------------------------------- */
/* The link store                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/** The account a user linked, or `null` when they never used the link flow. */
export function getLinkedAccount(userId: string): LinkedAccount | null {
  const row = database().prepare(SELECT_ALL).get(userId);
  return row === undefined ? null : toLinkedAccount(row);
}

/** Convenience predicate, so callers do not have to null-check a lookup they only want as a flag. */
export function isLinked(userId: string): boolean {
  return getLinkedAccount(userId) !== null;
}

/**
 * Records (or replaces) a user's link and returns what was stored.
 *
 * Re-linking is a normal correction, not a special case: the modal is the same one, and the new
 * value simply wins.
 *
 * THE CACHED RANK IS DROPPED HERE, and that is the only interesting thing this function does. See
 * `UPSERT_LINK` for why it happens in the same statement as the write. The link flow writes the
 * fresh snapshot back immediately afterwards, so the member still ends up with a cached rank.
 */
export function linkAccount(
  userId: string,
  riotId: { readonly name: string; readonly tag: string },
  now: number = Date.now(),
): LinkedAccount {
  database()
    .prepare(UPSERT_LINK)
    .run(userId, riotId.name, riotId.tag, now);
  return { name: riotId.name, tag: riotId.tag, userId, linkedAt: now };
}

/**
 * Forgets a user's link.
 *
 * The cached rank goes with it, because the consent is what authorised holding the rank at all.
 * Leaving a rank behind after an unlink would keep answering questions about an account whose owner
 * asked the bot to stop.
 *
 * @returns `true` when there was something to forget, so the caller can tell a real unlink from a
 *          button press on an already-unlinked account. That is the row count, which is why it is
 *          correct across a restart and not just within one process.
 */
export function unlinkAccount(userId: string): boolean {
  return database().prepare(DELETE_LINK).run(userId).changes > 0;
}

/** Number of links currently held. Exists for diagnostics and tests. */
export function linkedAccountCount(): number {
  return requireNumber(database().prepare(COUNT_LINKS).get() ?? {}, TABLE, 'total');
}

/**
 * Every linked account, or an empty list when nobody has linked.
 *
 * The periodic sync has to walk the whole set, and nothing above it was built for that: `getLinkedAccount`
 * is a single-row read and `linkedAccountCount` throws the rows away. One query, one statement.
 *
 * Rows that cannot be mapped are DROPPED rather than returned as nulls. The `WHERE riot_name IS NOT
 * NULL` filter already excludes every row this store does not recognise, so a row that still fails
 * to map means the CHECK constraint and the mapper have diverged — and handing the scheduler a
 * half-built account would produce a provider request with an empty Riot ID in it. Silently skipping
 * it keeps the pass honest: at worst one member goes one interval without a refreshed role.
 *
 * Ordered by user id, so two reads of the same database produce the same order. See `SELECT_LINKED`.
 */
export function listLinkedAccounts(): readonly LinkedAccount[] {
  const accounts: LinkedAccount[] = [];
  for (const row of database().prepare(SELECT_LINKED).all()) {
    const account = toLinkedAccount(row);
    if (account !== null) {
      accounts.push(account);
    }
  }
  return accounts;
}

/* -------------------------------------------------------------------------------------------- */
/* The join prompt decision                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * What a member answered to the one-time opt-in prompt, or `null` when they have never been asked.
 *
 * The single source of truth for "has this member already been prompted". The prompt handler asks
 * this before it sends anything, which is what makes the prompt one-time rather than best-effort:
 * a bot that restarts, or a member who rejoins, reads the same answer.
 */
export function getPromptDecision(userId: string): PromptDecision | null {
  const row = database().prepare(SELECT_PROMPT_DECISION).get(userId);
  if (row === undefined) {
    return null;
  }
  return toPromptDecision(optionalString(row, 'prompt_decision'));
}

/**
 * Records what a member answered and returns what was stored.
 *
 * An upsert rather than an insert, because a member who accepted, abandoned the modal and later
 * unlinked can genuinely answer again, and a second answer must win rather than collide with the
 * first. Only ever called from a button press, so this runs exactly once per human decision.
 *
 * @param now epoch milliseconds the answer was given. Injectable so a test can read the column back
 *             without consulting a clock.
 */
export function recordPromptDecision(
  userId: string,
  decision: PromptDecision,
  now: number = Date.now(),
): PromptDecision {
  database()
    .prepare(UPSERT_PROMPT_DECISION)
    .run(userId, decision, now);
  return decision;
}

/**
 * Drops every recorded decision.
 *
 * Test-only, and deliberately NOT folded into `resetLinkedAccounts`: that function means "forget the
 * links", and a test that wiped consent as a side effect of resetting rank data would quietly lose
 * the property it is supposed to be checking. Keeping them apart also keeps a future "reset the bot"
 * command honest — it would have to say which one it means.
 */
export function resetPromptDecisions(): void {
  database().prepare(DELETE_ALL_PROMPT_DECISIONS).run();
}

/* -------------------------------------------------------------------------------------------- */
/* The rank cache                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * The last rank read for a user, or `null` when nothing has been read yet.
 *
 * Returns the entry as it was stored and makes no judgement about age, so a caller that wants to
 * show something stale with its timestamp can, and a caller that wants a guaranteed-current answer
 * asks `isRankCacheFresh` instead of re-deriving the window. It also returns `null` for a user with
 * no row at all, which is the same answer the map gave.
 */
export function getCachedRank(userId: string): CachedRank | null {
  const row = database().prepare(SELECT_ALL).get(userId);
  return row === undefined ? null : toCachedRank(row);
}

/**
 * Whether a cached rank is still inside the provider's cache window.
 *
 * A pure comparison against `RANK_CACHE_TTL_MS`, with the clock passed in rather than read, so the
 * freshness rule is decided in one place and can be tested at its exact boundaries instead of by
 * waiting five minutes.
 *
 * Strictly younger than the window, matching what the provider promises: a snapshot exactly at the
 * limit has already expired upstream, so trusting it would mean reporting data the provider no
 * longer stands behind.
 */
export function isRankCacheFresh(cached: CachedRank, now: number = Date.now()): boolean {
  return now - cached.fetchedAt < RANK_CACHE_TTL_MS;
}

/**
 * Stores the rank just read for a user and returns what was stored.
 *
 * Only ever called with a snapshot the provider actually returned: a cache is not a place to
 * invent a value, and a failed lookup must leave the previous entry alone so a transient provider
 * blip does not erase a rank the bot already knew. Because the statement only touches the rank
 * columns, a blip cannot disturb the link either.
 */
export function cacheRank(userId: string, snapshot: RankSnapshot, now: number = Date.now()): CachedRank {
  database()
    .prepare(UPSERT_RANK)
    .run(
      userId,
      snapshot.riotId,
      snapshot.name,
      snapshot.tag,
      snapshot.platform,
      snapshot.affinity,
      snapshot.inferredAffinity,
      snapshot.tierName,
      snapshot.rankRating,
      snapshot.estimatedElo,
      snapshot.gamesNeededForRating,
      snapshot.lastChange,
      now,
    );
  return { snapshot, fetchedAt: now };
}

/**
 * Drops all state.
 *
 * Test-only, and NOT what a restart does any more — that is the whole point of this change. Nothing
 * in the running bot calls it: forgetting every member's consent on a whim is never a behaviour a
 * command should have.
 */
export function resetLinkedAccounts(): void {
  database().prepare(DELETE_ALL).run();
}

/* -------------------------------------------------------------------------------------------- */
/* Handle access                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Resolves the handle on every call instead of holding one in module scope.
 *
 * Two reasons. A test may swap the process-wide handle between cases, and a module-scoped handle
 * captured at import time would keep talking to a closed database. And the first call must not open
 * anything at import time, because importing this module must never create a file.
 */
function database(): Database {
  return getDatabase();
}
