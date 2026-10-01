import { describe, expect, it, vi } from 'vitest';

import {
  AccountNotFoundError,
  AccountNotInShardError,
  HenrikDevRankProvider,
  InvalidAffinityError,
  InvalidRiotIdError,
  isRetryableAcrossRegions,
  parseRiotId,
  RankAuthError,
  RankNetworkError,
  RankProviderNotConfiguredError,
  RankRateLimitedError,
  UnexpectedRankResponseError,
  type RankSnapshot,
} from './provider.js';
import { AFFINITIES, isAffinity } from './regions.js';
import { findTierByName } from './tiers.js';

const API_KEY = 'super-secret-key-value';
const BASE = 'https://api.henrikdev.xyz';

/** A response the way the endpoint actually answers a hit. */
function okBody(tierName: string, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    data: {
      account: { name: 'Dipplox', tag: 'LPARG' },
      current: {
        tier: { name: tierName },
        rr: 32,
        elo: 1932,
        games_needed_for_rating: 0,
        last_change: 8,
      },
      ...extra,
    },
  };
}

interface Scripted {
  readonly status?: number;
  readonly body?: unknown;
  readonly networkError?: boolean;
}

function fakeFetch(script: readonly Scripted[]) {
  const urls: string[] = [];
  let index = 0;

  const impl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    const step = script[index] ?? { status: 404, body: { errors: [{ code: 23 }] } };
    index += 1;
    if (step.networkError === true) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return { impl: impl as unknown as typeof fetch, urls };
}

function provider(fetchImpl: typeof fetch, apiKey: string | null = API_KEY) {
  return new HenrikDevRankProvider({ apiKey, fetchImpl, baseUrl: BASE });
}

describe('parseRiotId', () => {
  it('splits Name#TAG and uppercases the tag', () => {
    expect(parseRiotId('Dipplox#LPARG')).toEqual({ name: 'Dipplox', tag: 'LPARG' });
    expect(parseRiotId('  dipplox#lparg  ')).toEqual({ name: 'dipplox', tag: 'LPARG' });
  });

  it('rejects anything that is not a Riot ID', () => {
    for (const bad of ['', 'Dipplox', '#LPARG', 'Dipplox#', '  #  ', 'Dipplox#A#B']) {
      expect(() => parseRiotId(bad), bad).toThrow(InvalidRiotIdError);
    }
  });

  it('never puts the user text into the error, so a paste cannot smuggle markup', () => {
    try {
      parseRiotId('<@everyone>#EU1');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('<@everyone>');
    }
  });
});

describe('HenrikDevRankProvider.fetchRank', () => {
  it('returns a snapshot from the first region the tag implies', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('ASCENDANT 2') }]);

    const snapshot: RankSnapshot = await provider(impl).fetchRank({ riotId: 'Dipplox#LPARG' });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(`${BASE}/valorant/v3/mmr/latam/pc/Dipplox/LPARG`);
    expect(snapshot.tierName).toBe('ASCENDANT 2');
    expect(snapshot.tier?.name).toBe('Ascendant 2');
    expect(snapshot.rankRating).toBe(32);
    expect(snapshot.estimatedElo).toBe(1932);
    expect(snapshot.affinity).toBe('latam');
    expect(snapshot.inferredAffinity).toBe('latam');
    expect(snapshot.platform).toBe('pc');
  });

  it('sends the key in the Authorization header, never as X-API-Key', async () => {
    // Verified against the live API: X-API-Key returns 401 with a valid key.
    const seen: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const impl = vi.fn(async (input: string, init: RequestInit): Promise<Response> => {
      seen.push({ url: input, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify(okBody('Gold 1')));
    });

    await provider(impl as unknown as typeof fetch).fetchRank({ riotId: 'Player#EU1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers['Authorization']).toBe(API_KEY);
    // The key is the only header: nothing else should ride along with a credential.
    expect(Object.keys(seen[0]?.headers ?? {})).toEqual(['Authorization']);
  });

  it('falls back across regions in the documented order and stops at the first hit', async () => {
    // Code 25 means "valid region, account not in this shard": worth trying somewhere else.
    const { impl, urls } = fakeFetch([
      { body: { errors: [{ code: 25 }] } },
      { body: okBody('Diamond 1') },
    ]);

    const snapshot = await provider(impl).fetchRank({ riotId: 'Player#EU1' });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/eu/');
    expect(urls[1]).toContain('/latam/');
    expect(snapshot.affinity).toBe('latam');
    expect(snapshot.inferredAffinity).toBe('eu');
    expect(snapshot.tier?.name).toBe('Diamond 1');
  });

  it('finds a South American account through Riot resolving it on the na shard', async () => {
    const { impl, urls } = fakeFetch([
      { body: { errors: [{ code: 25 }] } },
      { body: okBody('Ascendant 2') },
    ]);

    const snapshot = await provider(impl).fetchRank({ riotId: 'Dipplox#LPARG' });

    // latam is inferred and misses, na is next and answers.
    expect(urls[0]).toContain('/latam/');
    expect(urls[1]).toContain('/na/');
    expect(snapshot.affinity).toBe('na');
  });

  it('prefers the "never played here" error after every region has been tried', async () => {
    // Code 23 across the board: the Riot ID itself is the problem, so that is what to report.
    const { impl, urls } = fakeFetch([{ body: { errors: [{ code: 23 }] } }]);

    await expect(provider(impl).fetchRank({ riotId: 'Ghost#EU1' })).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(urls).toHaveLength(AFFINITIES.length);
  });

  it('falls back to the last shard error when no region returned a 23', async () => {
    const { impl } = fakeFetch([{ body: { errors: [{ code: 25 }] } }]);

    await expect(provider(impl).fetchRank({ riotId: 'Ghost#EU1' })).rejects.toBeInstanceOf(
      AccountNotInShardError,
    );
  });

  it('never spends a request on an affinity outside the closed union', async () => {
    // Code 25 everywhere forces the full fallback list to be walked, so every requested affinity
    // is observed rather than assumed.
    const { impl, urls } = fakeFetch([{ body: { errors: [{ code: 25 }] } }]);

    await expect(provider(impl).fetchRank({ riotId: 'Player#ZZ9' })).rejects.toBeInstanceOf(
      AccountNotInShardError,
    );

    expect(urls).toHaveLength(6);
    for (const url of urls) {
      const affinity = /\/mmr\/([^/]+)\//.exec(url)?.[1] ?? '';
      expect(isAffinity(affinity), url).toBe(true);
    }
  });

  it('refuses to run at all without a key, instead of sending an unauthenticated request', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('Gold 1') }]);

    await expect(provider(impl, null).fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(
      RankProviderNotConfiguredError,
    );
    expect(urls).toHaveLength(0);
  });

  it('treats a blank key as no key', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('Gold 1') }]);

    await expect(provider(impl, '   ').fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(
      RankProviderNotConfiguredError,
    );
    expect(urls).toHaveLength(0);
  });
});

describe('provider error mapping', () => {
  it('maps code 6 to our own bug rather than the user', async () => {
    const { impl } = fakeFetch([{ body: { errors: [{ code: 6 }] } }]);

    await expect(provider(impl).fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(InvalidAffinityError);
  });

  it('does not retry a rejected key across every region', async () => {
    // One bad credential produces the same answer everywhere; six requests would only add load.
    const { impl, urls } = fakeFetch([{ status: 401 }]);

    await expect(provider(impl).fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(RankAuthError);
    expect(urls).toHaveLength(1);
  });

  it('treats 403 as a rejected key too', async () => {
    const { impl } = fakeFetch([{ status: 403 }]);

    await expect(provider(impl).fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(RankAuthError);
  });

  it('stops on a rate limit instead of hammering the provider five more times', async () => {
    const { impl, urls } = fakeFetch([{ status: 429 }]);

    await expect(provider(impl).fetchRank({ riotId: 'Player#EU1' })).rejects.toBeInstanceOf(RankRateLimitedError);
    expect(urls).toHaveLength(1);
  });

  it('treats a 404 as an account that was not found, and retries elsewhere', async () => {
    const { impl, urls } = fakeFetch([{ status: 404 }, { body: okBody('Iron 2') }]);

    const snapshot = await provider(impl).fetchRank({ riotId: 'Player#NA1' });

    expect(urls).toHaveLength(2);
    expect(snapshot.tier?.name).toBe('Iron 2');
  });

  it('reports a transport failure without leaking the URL it was fetching', async () => {
    const { impl } = fakeFetch([{ networkError: true }]);

    const error = await provider(impl)
      .fetchRank({ riotId: 'Player#EU1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RankNetworkError);
    expect((error as Error).message).not.toContain(BASE);
    expect((error as Error).message).not.toContain('fetch failed');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('reports an unmapped status without attaching the response body', async () => {
    const { impl } = fakeFetch([{ status: 503, body: { secret: 'do-not-print-me' } }]);

    const error = await provider(impl)
      .fetchRank({ riotId: 'Player#EU1' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnexpectedRankResponseError);
    expect((error as Error).message).not.toContain('do-not-print-me');
  });

  it('keeps the API key out of every error message it can produce', async () => {
    const scripts: ReadonlyArray<readonly Scripted[]> = [
      [{ status: 401 }],
      [{ status: 403 }],
      [{ status: 429 }],
      [{ status: 500, body: { key: API_KEY } }],
      [{ networkError: true }],
      [{ body: { errors: [{ code: 23 }] } }],
      [{ body: { errors: [{ code: 25 }] } }],
      [{ body: { errors: [{ code: 6 }] } }],
    ];

    for (const script of scripts) {
      const { impl } = fakeFetch(script);
      const error = await provider(impl)
        .fetchRank({ riotId: 'Player#EU1' })
        .catch((caught: unknown) => caught);

      expect(String((error as Error).message)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
    }
  });

  it('classifies only the two shard errors as worth retrying', () => {
    expect(isRetryableAcrossRegions(new AccountNotFoundError('eu'))).toBe(true);
    expect(isRetryableAcrossRegions(new AccountNotInShardError('eu'))).toBe(true);
    expect(isRetryableAcrossRegions(new RankAuthError())).toBe(false);
    expect(isRetryableAcrossRegions(new RankRateLimitedError())).toBe(false);
    expect(isRetryableAcrossRegions(new RankNetworkError())).toBe(false);
    expect(isRetryableAcrossRegions(new Error('unrelated'))).toBe(false);
  });
});

describe('tier names the provider returns', () => {
  it('resolves the uppercase names the endpoint actually uses, to the catalog role name', async () => {
    for (const reported of ['ASCENDANT 2', 'Ascendant 2', 'ascendant 2', 'Immortal 1', 'RADIANT', 'Unranked']) {
      const { impl } = fakeFetch([{ body: okBody(reported) }]);
      const snapshot = await provider(impl).fetchRank({ riotId: 'Player#EU1' });

      // The raw name is preserved for display; the role comes from the catalog entry.
      expect(snapshot.tierName, reported).toBe(reported);
      expect(snapshot.tier, reported).toEqual(findTierByName(reported));
    }
  });

  it('keeps an unknown tier name instead of discarding the whole lookup', async () => {
    // A new Riot tier must degrade to "no role", not to a failed command.
    const { impl } = fakeFetch([{ body: okBody('Ascendant 4') }]);
    const snapshot = await provider(impl).fetchRank({ riotId: 'Player#EU1' });

    expect(snapshot.tierName).toBe('Ascendant 4');
    expect(snapshot.tier).toBeNull();
  });

  it('reads a missing tier as Unranked', async () => {
    const { impl } = fakeFetch([{ body: { status: 200, data: { current: { rr: 0 } } } }]);
    const snapshot = await provider(impl).fetchRank({ riotId: 'Player#EU1' });

    expect(snapshot.tier?.name).toBe('Unranked');
    expect(snapshot.rankRating).toBe(0);
  });

  it('reports a null rating rather than pretending the value is zero', async () => {
    const { impl } = fakeFetch([{ body: { status: 200, data: { current: { tier: { name: 'Gold 1' } } } } }]);
    const snapshot = await provider(impl).fetchRank({ riotId: 'Player#EU1' });

    expect(snapshot.rankRating).toBeNull();
    expect(snapshot.estimatedElo).toBeNull();
  });
});

describe('platform', () => {
  it('defaults to pc', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('Gold 1') }]);
    await provider(impl).fetchRank({ riotId: 'Player#EU1' });

    expect(urls[0]).toBe(`${BASE}/valorant/v3/mmr/eu/pc/Player/EU1`);
  });

  it('passes console through', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('Gold 1') }]);
    await provider(impl).fetchRank({ riotId: 'Player#EU1', platform: 'console' });

    expect(urls[0]).toBe(`${BASE}/valorant/v3/mmr/eu/console/Player/EU1`);
  });

  it('falls back to pc for a platform it does not recognise', async () => {
    const { impl, urls } = fakeFetch([{ body: okBody('Gold 1') }]);
    await provider(impl).fetchRank({ riotId: 'Player#EU1', platform: 'mobile' });

    expect(urls[0]).toContain('/pc/');
  });
});
