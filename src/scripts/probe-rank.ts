/**
 * Rank provider probe.
 *
 * Calls the HenrikDev VALORANT MMR endpoint with the API key read from the environment and prints
 * only non-sensitive fields. The key is never logged, echoed, or included in any error message.
 *
 * This is the diagnostic to run first when a rank lookup "does not work": it separates
 * "the API key is wrong" from "the Riot ID is wrong" from "the region is wrong", which are three
 * different problems with three different fixes.
 *
 * Endpoint: GET /valorant/v3/mmr/{affinity}/{platform}/{name}/{tag}
 *
 * The key travels in the `Authorization` header. This is confirmed by the provider's own OpenAPI
 * spec, which declares `api_key_header` with `"name": "Authorization"`. The widely-copied
 * `X-API-Key` header is wrong and returns 401 with a perfectly valid key.
 *
 * Usage:
 *   npx tsx src/scripts/probe-rank.ts "RiotName#TAG" [region] [platform]
 *
 * Examples:
 *   npx tsx src/scripts/probe-rank.ts "SomePlayer#EU1"
 *   npx tsx src/scripts/probe-rank.ts "SomePlayer#NA1" na
 *   npx tsx src/scripts/probe-rank.ts "SomePlayer#AP1" ap console
 *
 * Environment:
 *   HENRIK_DEV_API_KEY  required, read from the environment (see .env.example)
 */

import 'dotenv/config';

/**
 * Valid `affinity` (region) values, verified against the live API.
 *
 * These are NOT the same strings people see in the VALORANT client. `LAS` and `LA` both return
 * error code 6 "Invalid region"; Latin America South is queried as `latam`. Riot's `na` shard also
 * resolves LATAM and BR accounts, so several of these return the same data for one account.
 */
const VALID_AFFINITIES = ['na', 'latam', 'br', 'eu', 'ap', 'kr'] as const;
const DEFAULT_AFFINITY = 'eu';

const API_BASE = 'https://api.henrikdev.xyz';
const DEFAULT_PLATFORM = 'pc';

interface Tier {
  readonly id: number;
  readonly name: string;
}

interface MmrPayload {
  readonly status?: number;
  readonly data?: {
    readonly account?: { readonly name?: string; readonly tag?: string; readonly puuid?: string };
    readonly current?: {
      readonly tier?: Tier;
      readonly rr?: number;
      readonly elo?: number;
      readonly games_needed_for_rating?: number;
      readonly last_change?: number;
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string; readonly code?: number }>;
}

/** Splits `Name#TAG`. Riot IDs are case-insensitive but the game displays them capitalised. */
function parseRiotId(input: string): { readonly name: string; readonly tag: string } {
  const hashIndex = input.indexOf('#');
  if (hashIndex <= 0 || hashIndex === input.length - 1) {
    throw new Error(`"${input}" is not a Riot ID. Expected the form Name#TAG, for example SomePlayer#EU1.`);
  }
  return {
    name: input.slice(0, hashIndex).trim(),
    tag: input.slice(hashIndex + 1).trim(),
  };
}

function explainFailure(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return 'The API key was rejected. Check HENRIK_DEV_API_KEY in your .env (or regenerate it in the dashboard).';
  }
  if (status === 404) {
    return `Account not found for that Riot ID in that region.\n  Known regions: ${VALID_AFFINITIES.join(', ')}.\n  Riot IDs are region-bound, and the region string is not the one shown in the game client: "LAS" is invalid, Latin America South is "latam".`;
  }
  if (status === 429) {
    return 'Rate limited. The free tier allows a limited number of requests per minute; wait and retry.';
  }
  return `Unexpected status ${status}. Raw response: ${body.slice(0, 300)}`;
}

async function main(): Promise<void> {
  const apiKey = process.env['HENRIK_DEV_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    console.error('HENRIK_DEV_API_KEY is not set. Add it to your .env before running this probe.');
    process.exitCode = 1;
    return;
  }

  const [riotIdArgument, region = DEFAULT_AFFINITY, platform = DEFAULT_PLATFORM] = process.argv.slice(2);
  if (riotIdArgument === undefined) {
    console.error('Usage: npx tsx src/scripts/probe-rank.ts "RiotName#TAG" [region] [platform]');
    console.error(`Regions: ${VALID_AFFINITIES.join(', ')}   Platforms: pc, console`);
    process.exitCode = 1;
    return;
  }

  if (!(VALID_AFFINITIES as readonly string[]).includes(region)) {
    console.error(`"${region}" is not a known region. Valid values: ${VALID_AFFINITIES.join(', ')}`);
    console.error('Note: Latin America South is "latam". "LAS" and "LA" are rejected by the API.');
    process.exitCode = 1;
    return;
  }

  const { name, tag } = parseRiotId(riotIdArgument);
  const path = `/valorant/v3/mmr/${encodeURIComponent(region)}/${encodeURIComponent(platform)}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;

  const response = await fetch(`${API_BASE}${path}`, { headers: { Authorization: apiKey } });
  const raw = await response.text();

  if (!response.ok) {
    console.error(`Request failed.\n  ${explainFailure(response.status, raw)}`);
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(raw) as MmrPayload;
  const current = payload.data?.current;
  const tier = current?.tier;

  console.log(`Riot ID     ${name}#${tag}`);
  console.log(`Region      ${region}   Platform ${platform}`);
  console.log(`Tier        ${tier?.name ?? '(none returned)'}  (id ${tier?.id ?? 'n/a'})`);
  console.log(`Rank rating ${current?.rr ?? 'n/a'}`);
  console.log(`Estimated Elo ${current?.elo ?? 'n/a'}`);
  console.log(`Games needed for rating: ${current?.games_needed_for_rating ?? 'n/a'}`);
  console.log(`Last change: ${current?.last_change ?? 'n/a'}`);

  if (current?.games_needed_for_rating !== undefined && current.games_needed_for_rating > 0) {
    console.log('\nThis account still has placements left, so the tier is not final yet.');
  }
}

await main();
