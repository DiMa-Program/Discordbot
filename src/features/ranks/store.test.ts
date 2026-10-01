import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase } from '../../core/db.js';
import { RANK_CACHE_TTL_MS, type RankSnapshot } from './provider.js';
import {
  cacheRank,
  getCachedRank,
  getPromptDecision,
  isLinked,
  getLinkedAccount,
  isRankCacheFresh,
  linkAccount,
  linkedAccountCount,
  listLinkedAccounts,
  recordPromptDecision,
  resetLinkedAccounts,
  resetPromptDecisions,
  unlinkAccount,
  type LinkedAccount,
} from './store.js';
import { findTierByName } from './tiers.js';

const USER = '111111111111111111';
const OTHER_USER = '222222222222222222';
const THIRD_USER = '333333333333333333';
const NOW = 1_700_000_000_000;

/**
 * A provider answer, built by hand.
 *
 * The store holds whole snapshots, so testing it means holding whole snapshots. Constructing one
 * directly is what keeps these tests about the store's own rules — ownership, freshness, invalidation
 * — rather than about the provider that would otherwise have to be faked to produce one.
 */
function snapshot(tierName = 'ASCENDANT 2'): RankSnapshot {
  return {
    riotId: 'Dipplox#LPARG',
    name: 'Dipplox',
    tag: 'LPARG',
    platform: 'pc',
    affinity: 'latam',
    inferredAffinity: 'latam',
    tierName,
    tier: findTierByName(tierName),
    rankRating: 32,
    estimatedElo: 1932,
    gamesNeededForRating: 0,
    lastChange: null,
  };
}

/** Sort key for comparing whole lists, so an ordering assertion is not an ordering accident. */
function byUserId(left: LinkedAccount | null, right: LinkedAccount | null): number {
  return (left?.userId ?? '').localeCompare(right?.userId ?? '');
}

beforeEach(() => {
  resetLinkedAccounts();
  resetPromptDecisions();
});

describe('the link store', () => {
  it('starts empty, so nobody is treated as linked by accident', () => {
    expect(getLinkedAccount(USER)).toBeNull();
    expect(isLinked(USER)).toBe(false);
    expect(linkedAccountCount()).toBe(0);
  });

  it('stores the Riot ID a user linked', () => {
    const stored = linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, 1_700_000_000_000);

    expect(stored).toEqual({
      name: 'Dipplox',
      tag: 'LPARG',
      userId: USER,
      linkedAt: 1_700_000_000_000,
    });
    expect(getLinkedAccount(USER)).toEqual(stored);
    expect(isLinked(USER)).toBe(true);
  });

  it('replaces the previous link when a user corrects their Riot ID', () => {
    linkAccount(USER, { name: 'Wrong', tag: 'EU1' });
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' });

    expect(getLinkedAccount(USER)).toMatchObject({ name: 'Dipplox', tag: 'LPARG' });
    expect(linkedAccountCount()).toBe(1);
  });

  it('keeps users isolated from one another', () => {
    linkAccount(USER, { name: 'First', tag: 'EU1' });
    linkAccount(OTHER_USER, { name: 'Second', tag: 'NA1' });

    expect(getLinkedAccount(USER)).toMatchObject({ name: 'First' });
    expect(getLinkedAccount(OTHER_USER)).toMatchObject({ name: 'Second' });
    expect(linkedAccountCount()).toBe(2);
  });

  it('reports whether an unlink had anything to forget', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' });

    expect(unlinkAccount(USER)).toBe(true);
    expect(unlinkAccount(USER)).toBe(false);
    expect(getLinkedAccount(USER)).toBeNull();
    expect(linkedAccountCount()).toBe(0);
  });

  it('clears every link on reset, which nothing in the running bot calls', () => {
    linkAccount(USER, { name: 'First', tag: 'EU1' });
    linkAccount(OTHER_USER, { name: 'Second', tag: 'NA1' });

    resetLinkedAccounts();

    expect(linkedAccountCount()).toBe(0);
  });
});

describe('the rank cache', () => {
  it('starts empty, so nobody is answered from a rank nobody read', () => {
    expect(getCachedRank(USER)).toBeNull();
  });

  it('stores the snapshot it was given with the time it was read', () => {
    const stored = cacheRank(USER, snapshot(), NOW);

    expect(stored).toEqual({ snapshot: snapshot(), fetchedAt: NOW });
    expect(getCachedRank(USER)).toEqual(stored);
  });

  it('treats a rank inside the provider window as fresh, and the limit itself as expired', () => {
    const cached = cacheRank(USER, snapshot(), NOW);

    expect(isRankCacheFresh(cached, NOW)).toBe(true);
    expect(isRankCacheFresh(cached, NOW + RANK_CACHE_TTL_MS - 1)).toBe(true);
    // Strictly younger than the window: at the limit the provider's own copy has already expired,
    // so reporting it would be reporting data upstream no longer stands behind.
    expect(isRankCacheFresh(cached, NOW + RANK_CACHE_TTL_MS)).toBe(false);
    expect(isRankCacheFresh(cached, NOW + RANK_CACHE_TTL_MS + 1)).toBe(false);
  });

  it('never reports a cached rank as fresher than it is when the clock disagrees', () => {
    // A clock that jumps backwards must not make a five-minute-old rank look new.
    const cached = cacheRank(USER, snapshot(), NOW);

    expect(isRankCacheFresh(cached, NOW - 10_000)).toBe(true);
  });

  it('replaces the cached rank on a new fetch instead of keeping the first one', () => {
    cacheRank(USER, snapshot('GOLD 1'), NOW);
    const stored = cacheRank(USER, snapshot('ASCENDANT 2'), NOW + 1_000);

    expect(stored.snapshot.tierName).toBe('ASCENDANT 2');
    expect(stored.fetchedAt).toBe(NOW + 1_000);
    expect(getCachedRank(USER)?.snapshot.tierName).toBe('ASCENDANT 2');
  });

  it('drops the cached rank when a member relinks, because it belonged to the other account', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    cacheRank(USER, snapshot('ASCENDANT 2'), NOW);

    linkAccount(USER, { name: 'SomeoneElse', tag: 'EU1' }, NOW + 1_000);

    // The alternative is telling someone their rank belongs to a different player.
    expect(getCachedRank(USER)).toBeNull();
  });

  it('drops the cached rank on unlink, because the consent is what authorised holding it', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    cacheRank(USER, snapshot(), NOW);

    unlinkAccount(USER);

    expect(getCachedRank(USER)).toBeNull();
  });

  it('keeps the cached rank of each member their own', () => {
    cacheRank(USER, snapshot('GOLD 1'), NOW);
    cacheRank(OTHER_USER, snapshot('RADIANT'), NOW);

    expect(getCachedRank(USER)?.snapshot.tierName).toBe('GOLD 1');
    expect(getCachedRank(OTHER_USER)?.snapshot.tierName).toBe('RADIANT');
  });

  it('clears the cached ranks on reset, and is still not what a restart does', () => {
    cacheRank(USER, snapshot(), NOW);
    cacheRank(OTHER_USER, snapshot(), NOW);

    resetLinkedAccounts();

    expect(getCachedRank(USER)).toBeNull();
    expect(getCachedRank(OTHER_USER)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Listing every link                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('listLinkedAccounts', () => {
  it('starts empty, so a scheduler with nobody linked has nothing to do', () => {
    expect(listLinkedAccounts()).toEqual([]);
  });

  it('returns every linked account, with the same shape the single-row read produces', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    linkAccount(OTHER_USER, { name: 'Someone', tag: 'EU1' }, NOW + 1);

    // Deep equality rather than identity: the rows come out of SQLite and are rebuilt from columns,
    // so two reads are never the same object. A scheduler that compared them by identity would treat
    // a fresh read as a different account.
    expect([...listLinkedAccounts()].sort(byUserId)).toEqual(
      [getLinkedAccount(USER), getLinkedAccount(OTHER_USER)].sort(byUserId),
    );
  });

  it('orders by user id, so two reads of the same database agree on the order', () => {
    // The sync turns this list into a work queue. An unstable order would make "already handled in
    // this pass" depend on the database's mood instead of on the account.
    linkAccount(THIRD_USER, { name: 'Third', tag: 'NA1' }, NOW);
    linkAccount(USER, { name: 'First', tag: 'EU1' }, NOW);
    linkAccount(OTHER_USER, { name: 'Second', tag: 'NA1' }, NOW);

    expect(listLinkedAccounts().map((account) => account.userId)).toEqual([USER, OTHER_USER, THIRD_USER]);
    expect(listLinkedAccounts().map((account) => account.userId)).toEqual([
      USER,
      OTHER_USER,
      THIRD_USER,
    ]);
  });

  it('leaves out rows that hold a rank but no link', () => {
    // The rank columns are independently nullable, so this row is possible and legitimate. It must
    // not appear here: the scheduler would have no Riot ID to look up.
    cacheRank(USER, snapshot(), NOW);

    expect(listLinkedAccounts()).toEqual([]);
    expect(linkedAccountCount()).toBe(0);
  });

  it('forgets a link the moment it is unlinked', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    linkAccount(OTHER_USER, { name: 'Someone', tag: 'EU1' }, NOW);

    unlinkAccount(USER);

    expect(listLinkedAccounts().map((account) => account.userId)).toEqual([OTHER_USER]);
  });

  it('agrees with linkedAccountCount, which is what the boot log reports', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    linkAccount(OTHER_USER, { name: 'Someone', tag: 'EU1' }, NOW);
    cacheRank(THIRD_USER, snapshot(), NOW);

    // Two ways of counting the same thing, and an operator confirming the boot log deserves to have
    // the second one agree with the list the scheduler will walk.
    expect(listLinkedAccounts()).toHaveLength(linkedAccountCount());
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The join prompt decision                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('the prompt decision', () => {
  it('reads as "never asked" for a member who has no row at all', () => {
    // Distinct from a refusal, and the distinction is the whole point: `null` is the only state in
    // which the join prompt may fire.
    expect(getPromptDecision(USER)).toBeNull();
  });

  it('round-trips both answers', () => {
    expect(recordPromptDecision(USER, 'accepted', NOW)).toBe('accepted');
    expect(getPromptDecision(USER)).toBe('accepted');

    expect(recordPromptDecision(OTHER_USER, 'declined', NOW)).toBe('declined');
    expect(getPromptDecision(OTHER_USER)).toBe('declined');
  });

  it('keeps each member their own answer', () => {
    recordPromptDecision(USER, 'accepted', NOW);
    recordPromptDecision(OTHER_USER, 'declined', NOW);

    expect(getPromptDecision(USER)).toBe('accepted');
    expect(getPromptDecision(OTHER_USER)).toBe('declined');
  });

  it('lets a second answer replace the first, because a real correction has to win', () => {
    recordPromptDecision(USER, 'declined', NOW);
    recordPromptDecision(USER, 'accepted', NOW + 1_000);

    expect(getPromptDecision(USER)).toBe('accepted');
  });

  it('stores a decline for a member who has no link, which is the whole point of the table', () => {
    recordPromptDecision(USER, 'declined', NOW);

    expect(getPromptDecision(USER)).toBe('declined');
    expect(getLinkedAccount(USER)).toBeNull();
    expect(isLinked(USER)).toBe(false);
    expect(listLinkedAccounts()).toEqual([]);
  });

  it('survives an unlink, because unlinking is not consent to be asked again', () => {
    // `unlinkAccount` deletes a whole `valorant_links` row. A decision kept in that row would be
    // deleted with it, and the member would be asked a question they had already answered.
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    recordPromptDecision(USER, 'declined', NOW);

    unlinkAccount(USER);

    expect(getLinkedAccount(USER)).toBeNull();
    expect(getPromptDecision(USER)).toBe('declined');
  });

  it('survives the link being replaced, because a relink does not change the answer', () => {
    linkAccount(USER, { name: 'Wrong', tag: 'EU1' }, NOW);
    recordPromptDecision(USER, 'accepted', NOW);

    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW + 1_000);

    expect(getPromptDecision(USER)).toBe('accepted');
  });

  it('is cleared by its own reset and not by the link reset, so the two never confuse a test', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    recordPromptDecision(USER, 'declined', NOW);

    resetLinkedAccounts();
    expect(getPromptDecision(USER)).toBe('declined');

    resetPromptDecisions();
    expect(getPromptDecision(USER)).toBeNull();
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Persistence                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Temp directories this file created, so a persistence test can never leave anything behind.
 *
 * Under the OS temp directory, never the working tree: a test that creates `data/` is a failing
 * test, and the point of the tests below is to prove the file survives a restart, not to litter the
 * repository with it.
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
 * `phase` is `'before'` for the first run and `'after'` for the second, and nothing carries over in
 * memory: the store resolves its handle on every call, so the second phase opens a genuinely new
 * connection. Anything still readable in `'after'` was really written to disk — which is the only
 * way to test this, because a suite that only ever round-trips through one live handle would pass
 * against a persistence layer that persisted nothing.
 */
function acrossRestart(body: (phase: 'before' | 'after') => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'discordbot-ranks-'));
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

describe('surviving a restart', () => {
  it('still has the link after the process handle is closed and reopened', () => {
    acrossRestart((phase) => {
      if (phase === 'before') {
        linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
        return;
      }
      expect(getLinkedAccount(USER)).toEqual({
        name: 'Dipplox',
        tag: 'LPARG',
        userId: USER,
        linkedAt: NOW,
      });
      expect(isLinked(USER)).toBe(true);
      expect(linkedAccountCount()).toBe(1);
    });
  });

  it('still has the cached rank, with its timestamp, so the cache window survives too', () => {
    acrossRestart((phase) => {
      if (phase === 'before') {
        linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
        cacheRank(USER, snapshot(), NOW);
        return;
      }
      const cached = getCachedRank(USER);
      expect(cached?.snapshot).toEqual(snapshot());
      expect(cached?.fetchedAt).toBe(NOW);
      // The freshness rule still works on a rank that was read before the restart, because the
      // timestamp travelled with it rather than being reset to "now".
      expect(isRankCacheFresh(cached!, NOW)).toBe(true);
      expect(isRankCacheFresh(cached!, NOW + RANK_CACHE_TTL_MS)).toBe(false);
    });
  });

  it('still honours an unlink made before the restart, instead of resurrecting the link', () => {
    acrossRestart((phase) => {
      if (phase === 'before') {
        linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
        cacheRank(USER, snapshot(), NOW);
        expect(unlinkAccount(USER)).toBe(true);
        return;
      }
      // Consent is deleted, not cached: a row that came back would keep answering questions about
      // an account whose owner asked the bot to stop.
      expect(getLinkedAccount(USER)).toBeNull();
      expect(getCachedRank(USER)).toBeNull();
      expect(unlinkAccount(USER)).toBe(false);
    });
  });

  it('still knows the member already answered, so a restart cannot re-ask the question', () => {
    // The promise the prompt makes is "exactly once", and a bot that forgets on boot would break it
    // on every deploy. This is the restart path that promise has to survive.
    acrossRestart((phase) => {
      if (phase === 'before') {
        expect(getPromptDecision(USER)).toBeNull();
        recordPromptDecision(USER, 'declined', NOW);
        return;
      }
      expect(getPromptDecision(USER)).toBe('declined');
    });
  });

  it('still lists every linked account after the process handle is closed and reopened', () => {
    // The scheduler's whole work queue comes from this. A process-wide handle that answered from a
    // stale cache would leave every member unrefreshed after a deploy, silently.
    acrossRestart((phase) => {
      if (phase === 'before') {
        linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
        linkAccount(OTHER_USER, { name: 'Someone', tag: 'EU1' }, NOW);
        return;
      }
      expect(listLinkedAccounts().map((account) => account.userId)).toEqual([USER, OTHER_USER]);
      expect(linkedAccountCount()).toBe(2);
    });
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Nullable rank columns                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('the nullable rank columns', () => {
  it('reads a link with no successful fetch as no rank at all, not as a zeroed one', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);

    // A link is only ever written after a successful lookup, but the schema has to survive a
    // lookup that failed anyway. Every rank column is NULL here, and every one must read back as
    // absent rather than as 0 or "".
    expect(getCachedRank(USER)).toBeNull();
    expect(getLinkedAccount(USER)).toMatchObject({ name: 'Dipplox', tag: 'LPARG', linkedAt: NOW });
  });

  it('round-trips every rank column when they are all present', () => {
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    const stored = cacheRank(USER, snapshot('ASCENDANT 2'), NOW);

    expect(getCachedRank(USER)).toEqual(stored);
  });

  it('keeps a null rank reading null instead of turning it into zero', () => {
    // An account with placements left has no rank rating yet. Reading that as 0 would tell a member
    // their competitive rank is zero, which is both wrong and alarming.
    const unplaced: RankSnapshot = {
      ...snapshot('IRON 1'),
      inferredAffinity: null,
      rankRating: null,
      estimatedElo: null,
      gamesNeededForRating: 2,
      lastChange: null,
    };
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    cacheRank(USER, unplaced, NOW);

    const cached = getCachedRank(USER);
    expect(cached?.snapshot.rankRating).toBeNull();
    expect(cached?.snapshot.estimatedElo).toBeNull();
    expect(cached?.snapshot.lastChange).toBeNull();
    expect(cached?.snapshot.inferredAffinity).toBeNull();
    // And the columns that DO have values are unaffected by their absent neighbours.
    expect(cached?.snapshot.gamesNeededForRating).toBe(2);
    expect(cached?.snapshot.tierName).toBe('IRON 1');
    expect(cached?.snapshot.tier).toEqual(findTierByName('IRON 1'));
    expect(cached?.fetchedAt).toBe(NOW);
  });

  it('reads a tier the catalog does not know as no tier, and keeps the name it was given', () => {
    // Riot adds tiers. A cached rank must not become unreadable when this build has not heard of one.
    const unknown = snapshot('Ascendant 4');
    expect(unknown.tier).toBeNull();
    cacheRank(USER, unknown, NOW);

    const cached = getCachedRank(USER);
    expect(cached?.snapshot.tier).toBeNull();
    expect(cached?.snapshot.tierName).toBe('Ascendant 4');
  });

  it('caches a rank for a user with no link, without inventing one', () => {
    // The rank columns and the link columns are independent, which is what lets this work.
    cacheRank(USER, snapshot(), NOW);

    expect(getCachedRank(USER)?.snapshot).toEqual(snapshot());
    expect(getLinkedAccount(USER)).toBeNull();
    expect(isLinked(USER)).toBe(false);
    // And a link written afterwards replaces the row without disturbing the rank's own columns'
    // all-or-nothing rule: it drops the rank, because it belonged to the previous account.
    linkAccount(USER, { name: 'SomeoneElse', tag: 'EU1' }, NOW + 1_000);
    expect(getCachedRank(USER)).toBeNull();
    expect(getLinkedAccount(USER)).toMatchObject({ name: 'SomeoneElse' });
  });
});
