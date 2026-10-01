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
 * WHAT IS STORED: the Riot ID and when it was linked. Nothing else. The provider's terms require
 * explicit per-user consent for a lookup, and that consent is captured by the link flow itself,
 * which is why a Riot ID is only ever written from inside the modal submit handler.
 */

/** A Riot ID a member has explicitly linked. */
export interface LinkedAccount {
  readonly name: string;
  readonly tag: string;
  /** Discord snowflake of the user that linked it. */
  readonly userId: string;
  /** Epoch milliseconds when the link was made, for display and for diagnosing stale state. */
  readonly linkedAt: number;
}

const accountsByUser = new Map<string, LinkedAccount>();

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
  return stored;
}

/**
 * Forgets a user's link.
 *
 * @returns `true` when there was something to forget, so the caller can tell a real unlink from a
 *          button press on an already-unlinked account.
 */
export function unlinkAccount(userId: string): boolean {
  return accountsByUser.delete(userId);
}

/** Number of links currently held. Exists for diagnostics and tests. */
export function linkedAccountCount(): number {
  return accountsByUser.size;
}

/**
 * Drops all state.
 *
 * Test-only. Nothing in the running bot calls it: forgetting every member's consent on a whim is
 * never a behaviour a command should have.
 */
export function resetLinkedAccounts(): void {
  accountsByUser.clear();
}
