/**
 * Linked Riot IDs, in memory.
 *
 * WHAT THIS IS NOT: durable storage. The map lives in module scope, so a restart, a redeploy or a
 * crash loses every link and every member has to link again. That is the accepted trade-off while
 * the feature is young, and it is the same trade-off `welcome/greeting-store.ts` already makes.
 * Swap this module for a real store and nothing above it changes.
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
 * THE CACHED RANK IS A SEPARATE MAP, AND IT IS DERIVED. A rank is a property of the ACCOUNT, not of
 * the person who happens to ask for it, so it is keyed the same way and it expires with the link
 * that authorised it. Keeping it apart from the consent record is what makes the two lifetimes
 * legible: linking and unlinking move both, while a rank refresh touches only the rank.
 */

import { RANK_CACHE_TTL_MS, type RankSnapshot } from './provider.js';

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

const accountsByUser = new Map<string, LinkedAccount>();
const ranksByUser = new Map<string, CachedRank>();

/** The account a user linked, or `null` when they never used the link flow. */
export function getLinkedAccount(userId: string): LinkedAccount | null {
  return accountsByUser.get(userId) ?? null;
}

/** Convenience predicate, so callers do not have to null-check a lookup they only want as a flag. */
export function isLinked(userId: string): boolean {
  return accountsByUser.has(userId);
}

/**
 * Records (or replaces) a user's link and returns what was stored.
 *
 * Re-linking is a normal correction, not a special case: the modal is the same one, and the new
 * value simply wins.
 *
 * THE CACHED RANK IS DROPPED HERE, and that is the only interesting thing this function does. A
 * rank cached under the previous Riot ID describes a different account, so serving it after a
 * relink would tell someone their own rank belongs to a stranger. The link flow writes the fresh
 * snapshot back immediately afterwards, so the member still ends up with a cached rank.
 */
export function linkAccount(
  userId: string,
  riotId: { readonly name: string; readonly tag: string },
  now: number = Date.now(),
): LinkedAccount {
  const stored: LinkedAccount = {
    name: riotId.name,
    tag: riotId.tag,
    userId,
    linkedAt: now,
  };
  accountsByUser.set(userId, stored);
  ranksByUser.delete(userId);
  return stored;
}

/**
 * Forgets a user's link.
 *
 * The cached rank goes with it, because the consent is what authorised holding the rank at all.
 * Leaving a rank behind after an unlink would keep answering questions about an account whose owner
 * asked the bot to stop.
 *
 * @returns `true` when there was something to forget, so the caller can tell a real unlink from a
 *          button press on an already-unlinked account.
 */
export function unlinkAccount(userId: string): boolean {
  ranksByUser.delete(userId);
  return accountsByUser.delete(userId);
}

/** Number of links currently held. Exists for diagnostics and tests. */
export function linkedAccountCount(): number {
  return accountsByUser.size;
}

/* -------------------------------------------------------------------------------------------- */
/* The rank cache                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * The last rank read for a user, or `null` when nothing has been read yet.
 *
 * Returns the entry as it was stored and makes no judgement about age, so a caller that wants to
 * show something stale with its timestamp can, and a caller that wants a guaranteed-current answer
 * asks `isRankCacheFresh` instead of re-deriving the window.
 */
export function getCachedRank(userId: string): CachedRank | null {
  return ranksByUser.get(userId) ?? null;
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
 * blip does not erase a rank the bot already knew.
 */
export function cacheRank(userId: string, snapshot: RankSnapshot, now: number = Date.now()): CachedRank {
  const stored: CachedRank = { snapshot, fetchedAt: now };
  ranksByUser.set(userId, stored);
  return stored;
}

/**
 * Drops all state.
 *
 * Test-only. Nothing in the running bot calls it: forgetting every member's consent on a whim is
 * never a behaviour a command should have.
 */
export function resetLinkedAccounts(): void {
  accountsByUser.clear();
  ranksByUser.clear();
}
