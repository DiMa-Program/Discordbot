import { beforeEach, describe, expect, it } from 'vitest';

import { RANK_CACHE_TTL_MS, type RankSnapshot } from './provider.js';
import {
  cacheRank,
  getCachedRank,
  isLinked,
  getLinkedAccount,
  isRankCacheFresh,
  linkAccount,
  linkedAccountCount,
  resetLinkedAccounts,
  unlinkAccount,
} from './store.js';
import { findTierByName } from './tiers.js';

const USER = '111111111111111111';
const OTHER_USER = '222222222222222222';
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

beforeEach(() => {
  resetLinkedAccounts();
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

  it('clears every link on reset, which is what a restart does', () => {
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

  it('clears the cached ranks on reset, which is what a restart does', () => {
    cacheRank(USER, snapshot(), NOW);
    cacheRank(OTHER_USER, snapshot(), NOW);

    resetLinkedAccounts();

    expect(getCachedRank(USER)).toBeNull();
    expect(getCachedRank(OTHER_USER)).toBeNull();
  });
});
