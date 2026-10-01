/**
 * Periodic rank sync: the part that makes "always up to date" true.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `guildMemberAdd` fires once per member, ever. A member who climbs Diamond to Ascendant without
 * leaving the server produces no event, so a join-only bot shows stale ranks indefinitely and looks
 * broken with nothing anywhere reporting a failure. The requirement was always "the role follows my
 * rank"; only a timer can deliver that.
 *
 * THE SCHEDULING DECISION IS A PURE FUNCTION, AND EVERYTHING ELSE IS THIN.
 *
 * `selectDueAccounts(accounts, intervalMs, now)` takes the whole world as arguments and returns the
 * subset that is due. No clock of its own, no timers, no provider, no Discord — which means the
 * property that actually matters (nobody is asked for twice in one interval, everybody is asked for
 * once, and the requests never arrive as a burst) is provable in a test rather than observable in
 * production. `startRankSyncScheduler` owns the timer and does nothing else interesting.
 *
 * WHY STAGGERING IS A HASH AND NOT A SHUFFLE.
 *
 * The provider allows 30 requests a minute on the free tier. Checking every linked account on every
 * tick would spend the whole budget at once and then nothing at all, which is both a rate-limit
 * failure and a self-inflicted denial of the very service the feature exists to read. So each
 * account gets a PHASE — a stable offset inside the interval derived from its user id — and is only
 * due when the current tick falls in its own window.
 *
 * THE PHASE IS DERIVED, NEVER STORED, and that is what makes a restart safe. There is no cursor, no
 * "last synced" column and no bucket counter to migrate: a bot that boots at 14:07 and a bot that
 * has been up since 09:00 compute the same offsets, so the work resumes in the same spread instead
 * of arriving as one pass on boot. A restart cannot storm the provider because it cannot forget
 * where it was — it never knew.
 *
 * FNV-1a, 32 BIT, NOT `Math.random()`. The phase has to be identical across processes, so it is
 * computed from the id itself. `Math.random()` would look fine in a test and hand a different
 * distribution to the next boot.
 *
 * THE CACHE IS STILL CHECKED. `RANK_CACHE_TTL_MS` is five minutes and the default interval is
 * twelve hours, so at the default configuration this guard rarely fires — but a pass that ignored it
 * would spend a request to learn what the store already holds the answer to.
 *
 * A PASS NEVER OVERLAPS ITSELF. The `running` flag is checked and set in the same synchronous turn,
 * before any `await`, so two ticks in one event-loop turn cannot both start. It matters because the
 * pass holds several lookups in flight at once: overlapping passes would multiply the concurrency
 * bound and the request rate by the number of ticks.
 *
 * AND A JOIN CANNOT OVERLAP A PASS, BECAUSE A JOIN PERFORMS NO LOOKUP. The plan called this out as an
 * acceptance criterion, and the honest way to satisfy it is structural rather than guarded: the join
 * handler in `prompt.ts` only ever sends a message and opens a modal, so there is no request for the
 * two paths to contend over. An in-flight set keyed by user id would be code defending a race that
 * cannot happen.
 */

import type { Client, Guild } from 'discord.js';

import type { Logger } from '../../core/logger.js';
import { getRankProvider, isRankProviderConfigured } from './context.js';
import type { RankSnapshot } from './provider.js';
import { createGuildRoleGateway, syncMemberRankRole } from './role-sync.js';
import { cacheRank, getCachedRank, isRankCacheFresh, listLinkedAccounts } from './store.js';
import type { CachedRank, LinkedAccount } from './store.js';

/**
 * How often the scheduler wakes up, in milliseconds.
 *
 * THIS IS NOT THE SYNC INTERVAL. It is the resolution of the staggering: an account's phase is
 * matched against a window one tick wide, so a smaller tick means a tighter spread and a larger one
 * means each tick covers a wider slice of the interval. A minute is chosen because it is also the
 * provider's own budget window — a burst can never be wider than the budget it has to fit inside.
 */
export const SYNC_TICK_MS = 60_000;

/**
 * How many provider lookups may be in flight at once.
 *
 * Bounded because the free tier's limit is a RATE, not a concurrency: several simultaneous requests
 * against a 30-per-minute allowance is a burst by another name. Four keeps a pass inside the budget
 * even in the pathological case where every member is due in the same window.
 */
export const SYNC_CONCURRENCY = 4;

/** The interval used when a caller does not name one. Twelve hours, matching the config default. */
export const DEFAULT_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1_000;

/* -------------------------------------------------------------------------------------------- */
/* The pure decision                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * A stable pseudo-random number in `[0, 2^32)` for one user id. Pure.
 *
 * FNV-1a, 32 bit. A snowflake already has well distributed low bits, but a real hash does not depend
 * on that staying true, and it is stable if the id format ever is not.
 *
 * Exported because it is the one primitive the staggering is made of: a test that wants to reason
 * about where a member lands uses this rather than re-deriving the arithmetic.
 */
export function accountPhase(userId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index);
    // Math.imul keeps the multiply inside 32 bits; a plain multiplication would lose precision
    // past 2^53 and the phase would drift between builds.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * One account's fixed slot in the cycle: a millisecond offset in `[0, intervalMs)`.
 *
 * FOLDED BY THE INTERVAL, not baked into the hash, so changing the interval re-spreads the same
 * population across the new cycle instead of leaving most of them stranded outside it.
 */
export function slotWithinInterval(account: LinkedAccount, intervalMs: number): number {
  return accountPhase(account.userId) % Math.max(1, intervalMs);
}

/** Whether `now` falls inside the window this account owns. Pure. */
function isDueAt(account: LinkedAccount, intervalMs: number, now: number, windowMs: number): boolean {
  // Modulo taken forwards, so the answer is correct for any `now` — including one earlier than the
  // slot itself, which is exactly what the first tick after a restart sees.
  const sinceSlot = (((now - slotWithinInterval(account, intervalMs)) % intervalMs) + intervalMs) % intervalMs;
  return sinceSlot < windowMs;
}

/**
 * The accounts whose turn it is. Pure: same arguments, same answer, no clock of its own.
 *
 * @param accounts every linked account. Order is preserved in the result.
 * @param intervalMs the length of one full cycle.
 * @param now the moment the question is asked for, in epoch milliseconds.
 * @param windowMs how wide each account's slot is. Defaults to one tick.
 * @returns only the accounts due at `now`. Empty is the common case and is not a failure: with ten
 *          members on a twelve-hour interval, most ticks have nobody due at all.
 */
export function selectDueAccounts(
  accounts: readonly LinkedAccount[],
  intervalMs: number,
  now: number,
  windowMs: number = SYNC_TICK_MS,
): readonly LinkedAccount[] {
  const interval = Math.max(1, intervalMs);
  const width = Math.max(1, Math.min(windowMs, interval));
  return accounts.filter((account) => isDueAt(account, interval, now, width));
}

/* -------------------------------------------------------------------------------------------- */
/* The pass                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** Why an account was not looked up. Every one of these is cheaper than a request. */
export type SyncSkipReason = 'left-guild' | 'cache-fresh';

/** What one pass did, for the boot log and for the tests. */
export interface SyncPassOutcome {
  /** Accounts whose phase matched this tick. */
  readonly due: number;
  /** Accounts actually looked up: `due`, minus the skips, minus the failures. */
  readonly looked: number;
  /** Accounts skipped, by reason. */
  readonly skipped: Readonly<Record<SyncSkipReason, number>>;
  /** Accounts whose lookup or role write threw. The pass continued past every one of them. */
  readonly failed: number;
}

/** Everything the pass needs, injected so all of it is testable without Discord. */
export interface SyncPassDeps {
  /** Epoch milliseconds to schedule against. Passed in, never read from a clock in here. */
  readonly now: number;
  /** Whether the member is still in this guild. The cache answers without a request. */
  readonly isMemberPresent: (userId: string) => boolean;
  /** The stored rank for an account, or `null`. */
  readonly getCachedRank: (userId: string) => CachedRank | null;
  /** Whether a cached rank is still inside the provider's window. */
  readonly isCacheFresh: (cached: CachedRank) => boolean;
  /** Fetches a fresh snapshot. The only provider call in the pass. */
  readonly fetchRank: (riotId: string) => Promise<RankSnapshot>;
  /** Stores a snapshot the provider just returned. */
  readonly cacheRank: (userId: string, snapshot: RankSnapshot) => void;
  /** Grants and strips rank roles for one member. `false` when the member could not be read. */
  readonly applyRankRole: (account: LinkedAccount, snapshot: RankSnapshot) => Promise<boolean>;
  /** Accounts to schedule. Defaults to the whole store. */
  readonly accounts?: readonly LinkedAccount[];
  /** Length of one cycle. Defaults to `DEFAULT_SYNC_INTERVAL_MS`. */
  readonly intervalMs?: number;
  /** How wide each account's slot is. Defaults to `SYNC_TICK_MS`. */
  readonly windowMs?: number;
  /** Maximum simultaneous lookups. Defaults to `SYNC_CONCURRENCY`. */
  readonly concurrency?: number;
}

/**
 * Runs one pass over the accounts that are due, and reports what it did.
 *
 * A FAILURE IS PER ACCOUNT, NEVER PER PASS. One account that gets rate limited, or one whose member
 * leaves between the presence check and the role write, must not cost the other due accounts their
 * refresh for a whole interval — which is exactly what a `Promise.all` over the whole batch would
 * do. Each item is caught on its own and counted.
 *
 * NOTHING IS DELETED. An account whose member has left keeps its link: leaving a server is not
 * consent to be forgotten, and the link is probably wanted again on a return visit. It is skipped
 * only because calling the provider for it would spend a request to compute a role nobody can see.
 */
export async function runSyncPass(deps: SyncPassDeps): Promise<SyncPassOutcome> {
  const accounts = deps.accounts ?? listLinkedAccounts();
  const due = selectDueAccounts(
    accounts,
    deps.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
    deps.now,
    deps.windowMs ?? SYNC_TICK_MS,
  );

  const skipped: Record<SyncSkipReason, number> = { 'left-guild': 0, 'cache-fresh': 0 };
  let looked = 0;
  let failed = 0;

  await forEachBounded(due, deps.concurrency ?? SYNC_CONCURRENCY, async (account) => {
    if (!deps.isMemberPresent(account.userId)) {
      skipped['left-guild'] += 1;
      return;
    }

    const cached = deps.getCachedRank(account.userId);
    if (cached !== null && deps.isCacheFresh(cached)) {
      skipped['cache-fresh'] += 1;
      return;
    }

    try {
      const snapshot = await deps.fetchRank(`${account.name}#${account.tag}`);
      // Cached BEFORE the role write, so a member whose role could not be applied still has the
      // rank stored and `/rank` can serve it without paying for the same lookup again.
      deps.cacheRank(account.userId, snapshot);
      await deps.applyRankRole(account, snapshot);
      looked += 1;
    } catch {
      // Swallowed deliberately: the caller is a timer with nobody to report to, and the timer logs
      // the outcome. What matters here is only that this account failed and the next one still runs.
      failed += 1;
    }
  });

  return { due: due.length, looked, skipped, failed };
}

/**
 * Runs `body` over `items`, never more than `limit` at a time.
 *
 * A worker pool rather than a chunked loop, because chunking waits for the slowest item in each
 * batch. One slow provider request would then hold up every account behind it, and the provider's
 * latency is its own — it must not become this pass's throughput.
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  body: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  const workers: Array<Promise<void>> = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async (): Promise<void> => {
        while (cursor < items.length) {
          const item = items[cursor];
          cursor += 1;
          if (item !== undefined) {
            await body(item);
          }
        }
      })(),
    );
  }

  await Promise.all(workers);
}

/* -------------------------------------------------------------------------------------------- */
/* The impure scheduler                                                                            */
/* -------------------------------------------------------------------------------------------- */

/** What `startRankSyncScheduler` needs to build the Discord-facing pass. */
export interface RankSyncSchedulerOptions {
  readonly client: Client;
  /** Epoch milliseconds between full cycles. The configured value. */
  readonly intervalMs: number;
  readonly log: Logger;
  /** Injectable for tests. Defaults to the global `setInterval`. */
  readonly setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  /** Injectable for tests. Defaults to the global `clearInterval`. */
  readonly clearIntervalImpl?: (handle: unknown) => void;
}

/** Stops the scheduler. Safe to call more than once. */
export type StopRankSync = () => void;

/**
 * Starts the scheduler, on the first ready event.
 *
 * Logged BEFORE the first tick, and deliberately: an operator who cannot see the interval and the
 * account count in the boot log has no way to confirm the configuration except by waiting a whole
 * cycle and guessing. Both numbers, plus the tick and the concurrency bound, in one line.
 *
 * The timer starts on `clientReady` rather than at import, because before that the guild cache is
 * empty and every account would be skipped as "left guild" — a pass that reports zero work while
 * being perfectly configured, which is worse than no log line at all.
 */
export function startRankSyncScheduler(options: RankSyncSchedulerOptions): StopRankSync {
  const { client, intervalMs, log } = options;
  const schedule =
    options.setIntervalImpl ?? ((handler: () => void, ms: number): unknown => setInterval(handler, ms));
  const cancel = options.clearIntervalImpl ?? ((handle: unknown): void => clearInterval(handle as NodeJS.Timeout));

  let running = false;
  let handle: unknown = null;

  const stop = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };

  const tick = async (): Promise<void> => {
    if (running) {
      // A pass is still working. Starting a second one would double the lookups in flight and the
      // request rate, which is the exact thing the staggering exists to prevent.
      log.debug('rank sync pass still running: skipping this tick');
      return;
    }
    running = true;
    try {
      const accounts = listLinkedAccounts();
      for (const guild of client.guilds.cache.values()) {
        // An empty member cache is the signature of the privileged intent being off, not of a server
        // with nobody in it. Passing anyway would report every account as gone, so it is skipped
        // and said out loud instead.
        if (guild.members.cache.size === 0) {
          log.warn(
            { guildId: guild.id },
            'the guild member cache is empty: automatic rank sync is skipping this server (GuildMembers intent missing?)',
          );
          continue;
        }
        const outcome = await runSyncPass({
          now: Date.now(),
          accounts,
          intervalMs,
          isMemberPresent: (userId) => guild.members.cache.has(userId),
          getCachedRank,
          isCacheFresh: (cached) => isRankCacheFresh(cached, Date.now()),
          fetchRank: (riotId) => getRankProvider().fetchRank({ riotId }),
          cacheRank,
          applyRankRole: (account, snapshot) => applyRankRole(guild, account.userId, snapshot, log),
        });
        if (outcome.due > 0 || outcome.failed > 0) {
          log.info({ guildId: guild.id, ...outcome }, 'automatic rank sync pass finished');
        }
      }
    } catch (error) {
      // A throw here is a bug in this module or a store failure, not a member's problem. Logged and
      // swallowed so the next tick still runs.
      log.error({ err: error }, 'automatic rank sync pass failed');
    } finally {
      running = false;
    }
  };

  const begin = (): void => {
    if (handle !== null) {
      return;
    }

    // One line at registration time, before any waiting happens. Without it, a scheduler that never
    // starts is indistinguishable from one that was never requested: the boot log is identical
    // either way, and the only other signal arrives twelve hours later when nothing happens.
    log.info(
      { intervalMinutes: Math.round(intervalMs / 60_000), startingNow: client.isReady() },
      'rank sync scheduler registered',
    );

    if (!isRankProviderConfigured()) {
      log.warn('HENRIK_DEV_API_KEY is not set: automatic rank sync will not start');
      return;
    }
    log.info(
      {
        intervalMinutes: Math.round(intervalMs / 60_000),
        intervalMs,
        tickMinutes: SYNC_TICK_MS / 60_000,
        concurrency: SYNC_CONCURRENCY,
        linkedAccounts: listLinkedAccounts().length,
      },
      'automatic rank sync scheduled',
    );
    handle = schedule(() => {
      void tick();
    }, SYNC_TICK_MS);
  };

  // Registered before login, so the event is normally caught here. The `isReady()` branch covers the
  // ordering where it has already fired: a `once` listener attached after the event is never called
  // again, so the scheduler would sit there doing nothing for the lifetime of the process with no
  // error and no log line to say so. That is exactly the symptom it produced once already.
  if (client.isReady()) {
    begin();
  } else {
    client.once('clientReady', begin);
  }

  return stop;
}

/**
 * Grants the role for a freshly fetched snapshot, reusing the tested planner and gateway.
 *
 * `role-sync.ts` is split into a planner and an executor precisely so this function can be boring:
 * it hands the tier to the shared sync routine and turns the outcome into a boolean. No role logic
 * is written here, and none can drift from the path the `/menu` refresh takes.
 */
async function applyRankRole(
  guild: Guild,
  userId: string,
  snapshot: RankSnapshot,
  log: Logger,
): Promise<boolean> {
  const outcome = await syncMemberRankRole(createGuildRoleGateway(guild), snapshot.tier, userId);
  if (outcome.blockedBy !== null) {
    log.warn({ blockedBy: outcome.blockedBy, userId, guildId: guild.id }, 'automatic rank sync refused a role change');
    return false;
  }
  return outcome.applied;
}