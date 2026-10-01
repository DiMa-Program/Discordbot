/**
 * Riot region (the API calls it `affinity`) handling.
 *
 * THE SET BELOW IS CLOSED, AND IT HAS TO STAY CLOSED.
 *
 * The provider rejects any affinity outside it with error code 6. The strings people see in the
 * VALORANT client are not the strings the API accepts: `LAS` and `LA` are both invalid, and Latin
 * America South is queried as `latam`. Because sending a bad affinity is a bug on our side and
 * never a problem the user can fix, `affinityCandidates` can only ever return values from this
 * union and the provider re-validates before spending a request.
 *
 * Region is INFERRED, never asked. Discord modals accept only text inputs — no select menu can be
 * placed inside one — so the link flow takes a single Riot ID and derives the region from its tag.
 * Inference is a best guess that is allowed to be wrong: the candidate list always carries
 * fallbacks, and Riot's `na` shard also resolves LATAM and BR accounts, which is what rescues South
 * American users when the guess misses.
 */

/** Every affinity the API accepts. Nothing outside this list may reach the network. */
export const AFFINITIES = ['na', 'latam', 'br', 'eu', 'ap', 'kr'] as const;
export type Affinity = (typeof AFFINITIES)[number];

/** Narrows an arbitrary string to the closed affinity union. */
export function isAffinity(value: string): value is Affinity {
  return (AFFINITIES as readonly string[]).includes(value);
}

/**
 * Regions tried when the inferred one does not resolve the account.
 *
 * `latam` leads because it is the shard South American players are actually on and a wrong `na`
 * guess is far more common there than the reverse. `na` follows for the same reason in reverse:
 * Riot's NA shard resolves LATAM and BR accounts too, so it is a surprisingly good universal
 * fallback. The rest follow so an account on any shard is still found.
 */
export const FALLBACK_AFFINITIES: readonly Affinity[] = ['latam', 'na', 'eu', 'ap', 'kr', 'br'];

/** Valve's platform names, which the MMR path also takes. */
export const PLATFORMS = ['pc', 'console'] as const;
export type Platform = (typeof PLATFORMS)[number];

const DEFAULT_PLATFORM: Platform = 'pc';

/** Narrows an arbitrary string to the platform union, defaulting to `pc`. */
export function resolvePlatform(value: string | undefined): Platform {
  return value === 'console' ? 'console' : DEFAULT_PLATFORM;
}

/**
 * Riot ID tag prefixes, longest first so no prefix can shadow a longer one.
 *
 * Matching is by prefix rather than by an exact list because Riot has shipped tag families
 * (`NA1`-`NA3`, `EU1`-`EU3`) that would each need their own entry otherwise, and because players
 * do carry tags from custom games. Prefix matching on the whole family is both shorter and more
 * forgiving without ever matching a tag from a different region.
 */
const TAG_PREFIXES: ReadonlyArray<readonly [string, Affinity]> = [
  ['LAT', 'latam'],
  ['LBR', 'latam'],
  ['LP', 'latam'],
  ['EU', 'eu'],
  ['NA', 'na'],
  ['AP', 'ap'],
  ['KR', 'kr'],
  ['BR', 'br'],
];

/**
 * The affinity a Riot ID tag most likely belongs to, or `null` when the tag is unrecognised.
 *
 * `null` is a normal answer, not a failure: an unrecognised tag simply falls back to the full
 * candidate list, which is slower but still finds the account.
 */
export function inferAffinityFromTag(tag: string): Affinity | null {
  const normalized = tag.trim().toUpperCase();
  for (const [prefix, affinity] of TAG_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return affinity;
    }
  }
  return null;
}

/**
 * Regions to try, in order: the inferred one first, then every fallback, without duplicates.
 *
 * Returns the fallback order untouched when the tag is unrecognised, so the caller always gets at
 * least one candidate and never has to special-case `null`.
 */
export function affinityCandidates(tag: string): Affinity[] {
  const inferred = inferAffinityFromTag(tag);
  if (inferred === null) {
    return [...FALLBACK_AFFINITIES];
  }
  return [inferred, ...FALLBACK_AFFINITIES.filter((affinity) => affinity !== inferred)];
}

/** Human-readable shard list, for error messages and the probe script's help text. */
export function describeAffinities(): string {
  return AFFINITIES.join(', ');
}
