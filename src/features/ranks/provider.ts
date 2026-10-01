/**
 * The rank data source.
 *
 * `RankProvider` is the whole contract, which is what makes the source swappable: a different
 * backend is a new class with one method, chosen at the single construction site in
 * `context.ts`. Nothing above this file knows the endpoint, the header, or the error codes.
 *
 * The key travels in the `Authorization` header. The widely-copied `X-API-Key` header returns 401
 * with a perfectly valid key; the provider's own OpenAPI spec declares `Authorization`.
 *
 * THE KEY IS NEVER LOGGED, ECHOED, OR ATTACHED TO AN ERROR. The key only ever exists in this
 * module's memory and in the outgoing request header, and no error constructed here embeds a
 * request URL, a response body, or any configuration value — so a thrown error can be logged
 * verbatim by whatever catches it without leaking the credential.
 */

import type { Affinity, Platform } from './regions.js';
import { AFFINITIES, affinityCandidates, inferAffinityFromTag, isAffinity, resolvePlatform } from './regions.js';
import { findTierByName, type RankTier } from './tiers.js';

const API_BASE = 'https://api.henrikdev.xyz';

/**
 * How long a rank stays acceptable without asking the provider again, in milliseconds.
 *
 * THE UPSTREAM WINDOW, NOT AN ARBITRARY ONE. The free tier caches a response for 300 seconds, so
 * re-reading inside that window costs a request and cannot return anything different. This is
 * therefore the number that keeps the feature inside the provider's rate limit: the common case for
 * a command someone runs twice is answered from memory.
 *
 * Equal to the window it is derived from, which is why it lives next to the endpoint rather than
 * in the store: the store decides when a cached rank has expired, and it can only do that honestly
 * while the window it measures against is the provider's own.
 */
export const RANK_CACHE_TTL_MS = 300_000;

/** Provider error codes this feature reacts to. Anything else is treated as unexpected. */
export const RANK_ERROR_CODES = {
  /** The region string we sent is invalid. Our bug; it must never reach a user. */
  INVALID_REGION: 6,
  /** The region is valid but this account has never played there. */
  ACCOUNT_NOT_FOUND: 23,
  /** The region is valid but this account does not live in that shard. */
  ACCOUNT_NOT_IN_SHARD: 25,
} as const;

/** A Riot ID split into its two halves. */
export interface RiotId {
  readonly name: string;
  readonly tag: string;
}

/** What a successful lookup yields. */
export interface RankSnapshot {
  /** `name#tag` exactly as the account is known, re-joined from the parsed input. */
  readonly riotId: string;
  readonly name: string;
  readonly tag: string;
  readonly platform: Platform;
  /**
   * The affinity that actually answered, not the one that was tried first.
   *
   * Recorded because a lookup that only resolves on the second candidate is worth knowing about:
   * the tag inference was wrong, and this is the signal to fix it.
   */
  readonly affinity: Affinity;
  /**
   * The affinity the tag pointed at, or `null` when the tag was unrecognised.
   *
   * Compared against `affinity` it tells the member their tag is misleading, which is otherwise
   * invisible: the lookup succeeded, so nothing looks wrong.
   */
  readonly inferredAffinity: Affinity | null;
  /** Tier name as the provider reported it, unmodified. */
  readonly tierName: string;
  /**
   * The catalog entry for `tierName`, or `null` when the provider named a tier this build does
   * not know about.
   *
   * A nullable tier is deliberate. Riot adds tiers, and a new one must not break the whole lookup:
   * the name is still shown, the role sync is simply skipped with an explanation.
   */
  readonly tier: RankTier | null;
  readonly rankRating: number | null;
  readonly estimatedElo: number | null;
  readonly gamesNeededForRating: number | null;
  readonly lastChange: number | null;
}

export interface RankRequest {
  /** `name#tag`. The region is inferred from the tag, never taken from the user. */
  readonly riotId: string;
  readonly platform?: string;
}

/** The one method the rest of the feature depends on. */
export interface RankProvider {
  fetchRank(request: RankRequest): Promise<RankSnapshot>;
}

/* -------------------------------------------------------------------------------------------- */
/* Errors                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Base class for every failure this module raises, so one `catch` can recognise the family. */
export class RankProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The bot is not configured for rank lookups. Recoverable by adding the env key. */
export class RankProviderNotConfiguredError extends RankProviderError {
  constructor() {
    super('No rank API key is configured for this bot, so rank lookups are unavailable.');
  }
}

/** The text the user typed is not a Riot ID. */
export class InvalidRiotIdError extends RankProviderError {
  constructor() {
    super('That is not a Riot ID. Expected the form Name#TAG, for example SomePlayer#EU1.');
  }
}

/**
 * An affinity outside the closed union reached the request builder.
 *
 * A defect guard, not a user-facing condition. It exists so that widening `AFFINITIES` in one place
 * without validating the other produces an exception in the log rather than error code 6 in a
 * channel.
 */
export class InvalidAffinityError extends RankProviderError {
  constructor(readonly affinity: string) {
    super(`Refusing to query an affinity outside the closed union: "${affinity}".`);
  }
}

/** The account has never played in the queried region, so the Riot ID's tag is probably wrong. */
export class AccountNotFoundError extends RankProviderError {
  constructor(readonly affinity: Affinity) {
    super(`No account was found in "${affinity}" for that Riot ID.`);
  }
}

/** The region is valid but the account lives in another shard, so another region may still work. */
export class AccountNotInShardError extends RankProviderError {
  constructor(readonly affinity: Affinity) {
    super(`That account does not live in the "${affinity}" shard.`);
  }
}

/** The provider is throttling this key. */
export class RankRateLimitedError extends RankProviderError {
  constructor() {
    super('The rank provider is rate limiting this bot. Try again in a few minutes.');
  }
}

/** The API key was rejected. Operator problem, never reported as a user mistake. */
export class RankAuthError extends RankProviderError {
  constructor() {
    super('The rank provider rejected the configured API key.');
  }
}

/** DNS, TLS, socket or timeout failure. */
export class RankNetworkError extends RankProviderError {
  constructor() {
    super('Could not reach the rank provider.');
  }
}

/** Any response the mapping below does not recognise. */
export class UnexpectedRankResponseError extends RankProviderError {
  constructor(readonly status: number) {
    super(`The rank provider returned an unexpected status: ${status}.`);
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Riot ID parsing                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Splits `Name#TAG`.
 *
 * Riot IDs are case-insensitive, so the parts are uppercased for the tag (tags are conventionally
 * shown uppercase and tag inference compares against uppercase prefixes) and the name is trimmed
 * but otherwise preserved.
 *
 * @throws {InvalidRiotIdError} when there is no `#`, or either half is empty.
 */
export function parseRiotId(input: string): RiotId {
  const trimmed = input.trim();
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex < 0) {
    throw new InvalidRiotIdError();
  }
  const name = trimmed.slice(0, hashIndex).trim();
  const tag = trimmed.slice(hashIndex + 1).trim();
  if (name === '' || tag === '' || tag.includes('#')) {
    throw new InvalidRiotIdError();
  }
  return { name, tag: tag.toUpperCase() };
}

/* -------------------------------------------------------------------------------------------- */
/* The HenrikDev provider                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** The subset of the response this feature reads. Everything else is ignored on purpose. */
interface MmrResponse {
  readonly status?: number;
  readonly data?: {
    readonly account?: { readonly name?: string; readonly tag?: string };
    readonly current?: {
      readonly tier?: { readonly name?: string };
      readonly rr?: number;
      readonly elo?: number;
      readonly games_needed_for_rating?: number;
      readonly last_change?: number;
    };
  };
  readonly errors?: ReadonlyArray<{ readonly code?: number }>;
}

export interface HenrikDevProviderOptions {
  /** `null` means "not configured": the provider refuses every request instead of failing a boot. */
  readonly apiKey: string | null;
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
}

/**
 * `RankProvider` backed by the HenrikDev VALORANT MMR endpoint.
 *
 * `GET {base}/valorant/v3/mmr/{affinity}/{platform}/{name}/{tag}`
 *
 * FALLBACK: the region is inferred from the Riot ID tag, and the remaining affinities are tried in
 * order until one answers. Only the two "this account is not in this shard" failures are worth
 * retrying somewhere else — a rejected key or a rate limit is answered the same way in every
 * region, so retrying would multiply the load on a provider that is already unhappy.
 */
export class HenrikDevRankProvider implements RankProvider {
  readonly #apiKey: string | null;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: HenrikDevProviderOptions) {
    this.#apiKey = options.apiKey?.trim() === '' ? null : (options.apiKey ?? null);
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? API_BASE;
  }

  /** True when a key is present, so the UI can explain setup instead of failing on first use. */
  get isConfigured(): boolean {
    return this.#apiKey !== null;
  }

  async fetchRank(request: RankRequest): Promise<RankSnapshot> {
    const key = this.#apiKey;
    if (key === null) {
      throw new RankProviderNotConfiguredError();
    }

    const { name, tag } = parseRiotId(request.riotId);
    const platform = resolvePlatform(request.platform);

    // A snapshot of "we never found it" plus the best reason why, so the caller can explain
    // itself after every candidate has failed.
    let firstFailure: RankProviderError | null = null;
    let lastFailure: RankProviderError | null = null;

    for (const affinity of affinityCandidates(tag)) {
      try {
        return await this.#fetchOne(key, { name, tag, platform, affinity, inferredAffinity: inferAffinityFromTag(tag) });
      } catch (error) {
        if (!isRetryableAcrossRegions(error)) {
          throw error;
        }
        lastFailure = error;
        if (firstFailure === null) {
          firstFailure = error;
        }
      }
    }

    throw firstFailure ?? lastFailure ?? new AccountNotFoundError(AFFINITIES[0]);
  }

  async #fetchOne(
    key: string,
    target: {
      readonly name: string;
      readonly tag: string;
      readonly platform: Platform;
      readonly affinity: Affinity;
      readonly inferredAffinity: Affinity | null;
    },
  ): Promise<RankSnapshot> {
    if (!isAffinity(target.affinity)) {
      throw new InvalidAffinityError(target.affinity);
    }

    const path =
      `/valorant/v3/mmr/${encodeURIComponent(target.affinity)}/` +
      `${encodeURIComponent(target.platform)}/` +
      `${encodeURIComponent(target.name)}/` +
      `${encodeURIComponent(target.tag)}`;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, { headers: { Authorization: key } });
    } catch {
      // The cause is deliberately dropped: a `TypeError: fetch failed` can carry the URL, and the
      // URL is one hop away from the header that authenticates the request.
      throw new RankNetworkError();
    }

    if (!response.ok) {
      throw toStatusError(response.status);
    }

    // The body is read but never attached to an error: a provider error page could echo request
    // headers, and an error object is exactly the kind of thing that ends up in a log line.
    const payload = (await response.json().catch(() => null)) as MmrResponse | null;
    const providerError = payload?.errors?.[0]?.code;
    if (providerError !== undefined) {
      throw toProviderCodeError(providerError, target.affinity);
    }

    return toSnapshot(payload, target);
  }
}

function toStatusError(status: number): RankProviderError {
  if (status === 401 || status === 403) {
    return new RankAuthError();
  }
  if (status === 429) {
    return new RankRateLimitedError();
  }
  if (status === 404) {
    // No `affinity` in the message: the caller is about to try a different one, and naming the
    // failed shard here would read as "your account is not in LATAM" when it may well be.
    return new AccountNotFoundError('na');
  }
  return new UnexpectedRankResponseError(status);
}

function toProviderCodeError(code: number, affinity: Affinity): RankProviderError {
  if (code === RANK_ERROR_CODES.INVALID_REGION) {
    return new InvalidAffinityError(affinity);
  }
  if (code === RANK_ERROR_CODES.ACCOUNT_NOT_FOUND) {
    return new AccountNotFoundError(affinity);
  }
  if (code === RANK_ERROR_CODES.ACCOUNT_NOT_IN_SHARD) {
    return new AccountNotInShardError(affinity);
  }
  return new UnexpectedRankResponseError(code);
}

function toSnapshot(
  payload: MmrResponse | null,
  target: {
    readonly name: string;
    readonly tag: string;
    readonly platform: Platform;
    readonly affinity: Affinity;
    readonly inferredAffinity: Affinity | null;
  },
): RankSnapshot {
  const current = payload?.data?.current;
  const tierName = current?.tier?.name ?? null;

  return {
    riotId: `${target.name}#${target.tag}`,
    name: payload?.data?.account?.name ?? target.name,
    tag: payload?.data?.account?.tag ?? target.tag,
    platform: target.platform,
    affinity: target.affinity,
    inferredAffinity: target.inferredAffinity,
    tierName: tierName ?? 'Unranked',
    tier: findTierByName(tierName),
    rankRating: current?.rr ?? null,
    estimatedElo: current?.elo ?? null,
    gamesNeededForRating: current?.games_needed_for_rating ?? null,
    lastChange: current?.last_change ?? null,
  };
}

/**
 * Whether a failure is worth spending another region on.
 *
 * Only "the account is not here" qualifies. Everything else — a rejected key, a rate limit, a dead
 * network — produces the same answer in every region, so retrying would turn one request into six.
 */
export function isRetryableAcrossRegions(error: unknown): error is RankProviderError {
  return error instanceof AccountNotFoundError || error instanceof AccountNotInShardError;
}
