/**
 * Tests for the periodic rank sync.
 *
 * THE SCHEDULING PROPERTIES ARE TESTED WITHOUT A CLOCK, BECAUSE THEY ARE THE WHOLE POINT.
 *
 * The claims worth proving are that every linked member is eventually refreshed, that nobody is
 * refreshed twice in one interval, and that the requests are spread across the interval instead of
 * arriving as one burst. None of those are observable at a twelve-hour interval in a test, which is
 * exactly why `selectDueAccounts` takes `now` as an argument: the sweep below walks a whole cycle one
 * tick at a time and asserts on the distribution.
 *
 * The pass is tested with injected dependencies, so "a member who left is never looked up" and "one
 * failure does not stop the pass" are real observations rather than inferences from reading the loop.
 */

import { describe, expect, it } from 'vitest';

import { findTierByName } from './tiers.js';
import { RANK_CACHE_TTL_MS, type RankSnapshot } from './provider.js';
import {
  accountPhase,
  DEFAULT_SYNC_INTERVAL_MS,
  runSyncPass,
  selectDueAccounts,
  slotWithinInterval,
  SYNC_CONCURRENCY,
  SYNC_TICK_MS,
  type SyncPassDeps,
} from './sync.js';
import type { CachedRank, LinkedAccount } from './store.js';

/** A real epoch so the arithmetic reads like the production one. */
const T0 = 1_700_000_000_000;

/**
 * Distinct snowflakes, spread by a stride rather than by a counter.
 *
 * A stride of a prime keeps consecutive ids from hashing into consecutive slots, which would make a
 * staggering test pass for the wrong reason.
 */
function accounts(count: number): readonly LinkedAccount[] {
  const base = 100000000000000000n;
  return Array.from({ length: count }, (_unused, index) => ({
    name: `Player${index}`,
    tag: 'LPARG',
    userId: (base + BigInt(index) * 7919n).toString(),
    linkedAt: T0,
  }));
}

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

function cached(fetchedAt: number, tierName = 'ASCENDANT 2'): CachedRank {
  return { snapshot: snapshot(tierName), fetchedAt };
}

/** One pass's worth of observations, all of them injectable. */
interface PassRecorder {
  readonly requested: string[];
  readonly applied: string[];
  readonly cached: string[];
  readonly failures: ReadonlySet<string>;
  readonly inFlightPeak: number;
  readonly deps: SyncPassDeps;
}

interface PassOptions {
  readonly present?: (userId: string) => boolean;
  readonly cache?: Map<string, CachedRank>;
  readonly concurrency?: number;
  readonly intervalMs?: number;
  readonly now?: number;
  readonly accountsForTest?: readonly LinkedAccount[];
}

/**
 * A pass wired to recorders.
 *
 * `failFor` makes the PROVIDER throw for named Riot IDs, so "one member's failure does not stop the
 * others" is proved with a real rejected promise travelling the real loop rather than by asserting
 * on a hand-written catch.
 */
function recorder(options: PassOptions & { readonly failFor?: ReadonlySet<string> } = {}): PassRecorder {
  const requested: string[] = [];
  const applied: string[] = [];
  const cacheWrites: string[] = [];
  const failFor = options.failFor ?? new Set<string>();
  const cache = options.cache ?? new Map<string, CachedRank>();
  const now = options.now ?? T0;
  let inFlight = 0;
  let peak = 0;

  const deps: SyncPassDeps = {
    now,
    intervalMs: options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
    accounts: options.accountsForTest ?? [],
    isMemberPresent: options.present ?? ((): boolean => true),
    getCachedRank: (userId) => cache.get(userId) ?? null,
    isCacheFresh: (entry) => entry.fetchedAt + RANK_CACHE_TTL_MS > now,
    fetchRank: async (riotId) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      requested.push(riotId);
      try {
        if (failFor.has(riotId)) {
          throw new Error('the provider is rate limiting this bot');
        }
        // Yields once, so an unbounded implementation really would overlap and really would exceed
        // the bound. Without a yield every implementation trivially looks serialised.
        await Promise.resolve();
        return snapshot();
      } finally {
        inFlight -= 1;
      }
    },
    cacheRank: (userId) => {
      cacheWrites.push(userId);
    },
    applyRankRole: async (account) => {
      applied.push(account.userId);
      return true;
    },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  };

  // A getter, not a value: `peak` is only reached during the pass, long after this object is built,
  // and a captured number would read as zero forever.
  return {
    requested,
    applied,
    cached: cacheWrites,
    failures: failFor,
    get inFlightPeak(): number {
      return peak;
    },
    deps,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The pure scheduling decision                                                                    */
/* -------------------------------------------------------------------------------------------- */

describe('accountPhase', () => {
  it('is a function of the user id alone, which is what makes a restart safe', () => {
    // Derived, never stored: there is no cursor to lose, so a bot that boots at 14:07 computes the
    // same offsets as one that has been up since 09:00.
    expect(accountPhase('111111111111111111')).toBe(accountPhase('111111111111111111'));
    expect(accountPhase('111111111111111111')).not.toBe(accountPhase('222222222222222222'));
  });

  it('stays inside a 32-bit range, so the phase cannot drift between builds', () => {
    for (const account of accounts(200)) {
      const phase = accountPhase(account.userId);
      expect(Number.isInteger(phase)).toBe(true);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  it('places every account inside the interval it is scheduled against', () => {
    for (const account of accounts(50)) {
      const slot = slotWithinInterval(account, DEFAULT_SYNC_INTERVAL_MS);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(DEFAULT_SYNC_INTERVAL_MS);
    }
  });
});

describe('selectDueAccounts', () => {
  const TICK_COUNT = DEFAULT_SYNC_INTERVAL_MS / SYNC_TICK_MS;

  it('selects nobody from an empty population', () => {
    expect(selectDueAccounts([], DEFAULT_SYNC_INTERVAL_MS, T0)).toEqual([]);
  });

  it('selects nobody twice within one interval, at 10, 50 and 150 members', () => {
    for (const count of [10, 50, 150]) {
      const population = accounts(count);
      const times = new Map<string, number>();

      // One whole cycle, one tick at a time. Exactly `TICK_COUNT` samples, so the wrap-around tick
      // is not counted a second time — a member whose slot sits on the boundary is due at the first
      // tick of the next cycle, not twice in this one.
      for (let tick = 0; tick < TICK_COUNT; tick += 1) {
        for (const account of selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + tick * SYNC_TICK_MS)) {
          times.set(account.userId, (times.get(account.userId) ?? 0) + 1);
        }
      }

      expect([...times.values()].every((seen) => seen === 1)).toBe(true);
    }
  });

  it('selects everybody eventually, at 10, 50 and 150 members', () => {
    for (const count of [10, 50, 150]) {
      const population = accounts(count);
      const seen = new Set<string>();

      for (let tick = 0; tick < TICK_COUNT; tick += 1) {
        for (const account of selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + tick * SYNC_TICK_MS)) {
          seen.add(account.userId);
        }
      }

      // Nobody is left behind forever, which is the promise the feature is sold on.
      expect(seen.size).toBe(count);
    }
  });

  it('spreads the work across the interval instead of arriving as one burst', () => {
    for (const count of [10, 50, 150]) {
      const population = accounts(count);
      const perTick: number[] = [];

      for (let tick = 0; tick < TICK_COUNT; tick += 1) {
        perTick.push(selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + tick * SYNC_TICK_MS).length);
      }

      const busyTicks = perTick.filter((due) => due > 0).length;
      const worstBurst = Math.max(...perTick);

      // Two independent claims, because either alone could be satisfied by a broken scheduler. A
      // burst passes the "bounded burst" check and fails the spread one; a scheduler that spread into
      // far too many ticks would fail the other.
      //
      // Measured here: 10 members over 10 distinct ticks, 50 over 47, 150 over 136 — so the ratio
      // below holds with room to spare, and a scheduler that checked everybody at once scores 1/n.
      expect(busyTicks / count).toBeGreaterThanOrEqual(0.8);
      // At most a twentieth of the population in any one minute. Measured worst cases at these
      // sizes are 1, 2 and 4, so this has room to spare without permitting a real spike.
      expect(worstBurst).toBeLessThanOrEqual(Math.ceil(count / 20));
    }
  });

  it('selects nothing on a boot that lands between two slots, so a restart cannot storm the provider', () => {
    // The property the plan asked for by name: "on boot, do not immediately fire a full pass". A
    // restart mid-cycle must resume in the same spread, and the common case is that the very first
    // tick has nobody due at all.
    const population = accounts(150);
    const busyTicks = new Set<number>();

    for (let tick = 0; tick < TICK_COUNT; tick += 1) {
      const now = T0 + tick * SYNC_TICK_MS;
      if (selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, now).length > 0) {
        busyTicks.add(now);
      }
    }

    expect(busyTicks.has(T0)).toBe(false);
    // And the same instant always gives the same answer, whatever "later" means: no stored state
    // means nothing can differ between the process that has been up all day and the one that just
    // started.
    expect(selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + 37 * SYNC_TICK_MS)).toEqual(
      selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + 37 * SYNC_TICK_MS),
    );
  });

  it('picks a different subset for each tick, rather than one standing group', () => {
    // The complement of "always the same members": if only the same five accounts were ever due, the
    // other 145 would show a stale rank forever and every test above would still pass.
    const population = accounts(50);
    const first = new Set(selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0).map((a) => a.userId));
    const later = new Set(
      Array.from({ length: TICK_COUNT }, (_u, tick) => T0 + tick * SYNC_TICK_MS)
        .flatMap((now) => selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, now).map((a) => a.userId))
        .filter((id) => !first.has(id)),
    );

    expect(later.size).toBe(50 - first.size);
  });

  it('never selects anybody outside the population it was given', () => {
    const population = accounts(20);
    const known = new Set(population.map((account) => account.userId));

    for (let tick = 0; tick < TICK_COUNT; tick += 1) {
      for (const account of selectDueAccounts(population, DEFAULT_SYNC_INTERVAL_MS, T0 + tick * SYNC_TICK_MS)) {
        expect(known.has(account.userId)).toBe(true);
      }
    }
  });

  it('falls back to a sane answer for a nonsensical interval rather than selecting everybody', () => {
    // A zero interval would divide by zero and a negative one would make every account permanently
    // due. Both are configuration errors the schema already prevents; this is the last line of
    // defence so a bad number cannot turn into a burst.
    expect(selectDueAccounts(accounts(50), 0, T0).length).toBeLessThanOrEqual(50);
    expect(selectDueAccounts(accounts(50), -1, T0).length).toBeLessThanOrEqual(50);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The pass                                                                                        */
/* -------------------------------------------------------------------------------------------- */

describe('runSyncPass', () => {
  /**
   * Finds the instant the given account is due, so a pass test does not depend on a hash value.
   *
   * The pass is driven through `selectDueAccounts` rather than round-tripped through the real store,
   * so the skip and failure rules are tested independently of the staggering.
   */
  function dueAt(account: LinkedAccount, intervalMs = DEFAULT_SYNC_INTERVAL_MS): number {
    for (let tick = 0; tick <= intervalMs / SYNC_TICK_MS; tick += 1) {
      const now = T0 + tick * SYNC_TICK_MS;
      if (selectDueAccounts([account], intervalMs, now).length === 1) {
        return now;
      }
    }
    throw new Error('the account was never due in one whole interval');
  }

  /** The mirror of `dueAt`: a tick inside the cycle at which this account is NOT due. */
  function notDueAt(account: LinkedAccount, intervalMs = DEFAULT_SYNC_INTERVAL_MS): number {
    for (let tick = 0; tick <= intervalMs / SYNC_TICK_MS; tick += 1) {
      const now = T0 + tick * SYNC_TICK_MS;
      if (selectDueAccounts([account], intervalMs, now).length === 0) {
        return now;
      }
    }
    throw new Error('the account was due on every tick, which the staggering forbids');
  }

/**
 * A population of accounts that all become due in the SAME tick, found by construction.
 *
 * The busy-tick tests need several accounts due at one instant, and waiting for a collision by luck
 * would make them depend on how the hash happens to spread this particular set of ids. Constructing
 * the population instead keeps them deterministic, and lets each test say exactly what situation it
 * is exercising.
 *
 * WHICH HALF OF THE WINDOW MATTERS, AND WHY IT IS NOT THE OBVIOUS ONE. Slots are millisecond-resolution
 * values inside a twelve-hour interval, so two accounts colliding on the same millisecond is
 * vanishingly rare — the interesting crowd is the accounts whose slots fall inside the same one-MINUTE
 * window, because that is what a tick actually collects. So this builds accounts with a slot in the
 * first half of the window and evaluates at the window's midpoint.
 *
 * Candidates come from a seeded 32-bit LCG rather than a counter, for two reasons. Consecutive ids
 * produce strongly correlated hashes, so a counter would need millions of tries to land in a chosen
 * slot. And `state % 10` reads the low bits of an LCG, which repeat on a two- or four-step cycle and
 * would generate the same few digits forever, so the digits are taken from the scaled high bits
 * instead. The seed is fixed, so the population is identical on every run and the test cannot pass by
 * luck on one machine.
 */
function accountsDueTogether(count: number, intervalMs = DEFAULT_SYNC_INTERVAL_MS): readonly LinkedAccount[] {
  const found: LinkedAccount[] = [];
  let state = 0x1a2b3c4d >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };

  for (let attempt = 0; attempt < 200_000 && found.length < count; attempt += 1) {
    let userId = '';
    for (let digit = 0; digit < 18; digit += 1) {
      userId += String(Math.floor((next() / 0x1_0000_0000) * 10));
    }
    const slot = slotWithinInterval({ name: 'Player', tag: 'LPARG', userId, linkedAt: T0 }, intervalMs);
    if (slot < SYNC_TICK_MS / 2) {
      found.push({ name: `Player${found.length}`, tag: 'LPARG', userId, linkedAt: T0 });
    }
  }

  if (found.length < count) {
    throw new Error(`could not construct ${count} accounts due on one tick; the hash is not spreading`);
  }
  return found;
}

/** The instant every account from `accountsDueTogether` is due: the midpoint of the shared window. */
const SHARED_TICK_NOW = Math.floor(T0 / DEFAULT_SYNC_INTERVAL_MS) * DEFAULT_SYNC_INTERVAL_MS + SYNC_TICK_MS / 2;

it('does nothing at all when nobody is due, without touching the provider', async () => {
    const account = accounts(1)[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const built = recorder({ now: notDueAt(account), accountsForTest: [account] });

    const outcome = await runSyncPass(built.deps);

    expect(outcome).toEqual({ due: 0, looked: 0, skipped: { 'left-guild': 0, 'cache-fresh': 0 }, failed: 0 });
    expect(built.requested).toEqual([]);
  });

  it('looks up a due member and applies their role', async () => {
    const population = accounts(1);
    const account = population[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const built = recorder({ now: dueAt(account), accountsForTest: population });

    const outcome = await runSyncPass(built.deps);

    expect(outcome.due).toBe(1);
    expect(outcome.looked).toBe(1);
    expect(built.requested).toEqual(['Player0#LPARG']);
    expect(built.applied).toEqual([account.userId]);
    // The fresh snapshot is stored, so the next `/rank` for this member is answered from memory.
    expect(built.cached).toEqual([account.userId]);
  });

  it('skips a member who is no longer in the guild and never reaches the provider for them', async () => {
    const population = accounts(1);
    const account = population[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const built = recorder({ now: dueAt(account), accountsForTest: population, present: () => false });

    const outcome = await runSyncPass(built.deps);

    expect(outcome.skipped['left-guild']).toBe(1);
    expect(outcome.looked).toBe(0);
    expect(built.requested).toEqual([]);
    expect(built.applied).toEqual([]);
  });

  it('skips a member whose cached snapshot is still fresh, so no request is spent', async () => {
    const account = accounts(1)[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const now = dueAt(account);
    const cache = new Map([[account.userId, cached(now - 1)]]);
    const built = recorder({ now, cache, accountsForTest: [account] });

    const outcome = await runSyncPass(built.deps);

    // At a twelve-hour interval this rarely fires, but it is the same rule the join-side refresh
    // obeys, and a pass that ignored it would buy what the store already knows.
    expect(outcome.skipped['cache-fresh']).toBe(1);
    expect(outcome.looked).toBe(0);
    expect(built.requested).toEqual([]);
  });

  it('looks a member up again once the cached snapshot falls out of the provider window', async () => {
    const account = accounts(1)[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const now = dueAt(account);
    const cache = new Map([[account.userId, cached(now - RANK_CACHE_TTL_MS)]]);
    const built = recorder({ now, cache, accountsForTest: [account] });

    const outcome = await runSyncPass(built.deps);

    expect(outcome.looked).toBe(1);
    expect(built.requested).toHaveLength(1);
  });

  it('keeps going when one member fails, so one bad account cannot cost the others the interval', async () => {
    // The worst tick for a batch implementation: every account due at once, one of them throwing. A
    // `Promise.all` over the batch would abandon the rest of it.
    const population = accountsDueTogether(6);
    const broken = `${population[0]?.name ?? ''}#LPARG`;
    const built = recorder({ now: SHARED_TICK_NOW, failFor: new Set([broken]), accountsForTest: population });

    const outcome = await runSyncPass(built.deps);

    expect(outcome.due).toBe(6);
    expect(outcome.failed).toBe(1);
    expect(built.requested).toContain(broken);
    expect(outcome.looked).toBe(5);
    // Everyone who could succeed did, including the accounts queued behind the failing one.
    expect(built.applied).toHaveLength(5);
  });

  it('counts a failed role write as a failure without abandoning the snapshot it just cached', async () => {
    const account = accounts(1)[0];
    if (account === undefined) {
      throw new Error('accounts(1) must produce one account');
    }
    const now = dueAt(account);
    const built = recorder({ now, accountsForTest: [account] });
    const failing: SyncPassDeps = {
      ...built.deps,
      applyRankRole: async () => {
        throw new Error('Missing Permissions');
      },
    };

    const outcome = await runSyncPass(failing);

    expect(outcome.failed).toBe(1);
    // The rank is cached before the role write, so `/rank` can still serve this member for free even
    // though the role could not be moved.
    expect(built.cached).toHaveLength(1);
  });

  it('never has more than the concurrency bound in flight at once', async () => {
    // Accounts due in the same slot are exactly the burst the staggering exists to limit, so the
    // bound has to hold when they all land together.
    const population = accountsDueTogether(SYNC_CONCURRENCY + 2);
    const built = recorder({ now: SHARED_TICK_NOW, accountsForTest: population });

    await runSyncPass(built.deps);

    expect(built.inFlightPeak).toBeLessThanOrEqual(SYNC_CONCURRENCY);
    // And it really did run them in parallel: a serial implementation would trivially satisfy the
    // upper bound, and the bug this guards against is the opposite one.
    expect(built.inFlightPeak).toBeGreaterThan(1);
  });

it('asks for nothing when the account list is empty', async () => {
    const built = recorder({ now: T0, accountsForTest: [] });

    const outcome = await runSyncPass(built.deps);

    expect(outcome.due).toBe(0);
    expect(built.requested).toEqual([]);
  });
});
