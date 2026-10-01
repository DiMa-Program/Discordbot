/**
 * The VALORANT competitive rank catalog.
 *
 * WHY TIER NAMES AND NOT TIER IDS.
 *
 * Riot renumbered the tiers when Ascendant was introduced in Episode 6, shifting every id from 21
 * upward. Tier id 21 was `IMMORTAL 1` and is now `ASCENDANT 1` — and `https://valorant-api.com/v1/
 * competitivetiers` still serves the PRE-Ascendant `Episode1_CompetitiveTierDataTable` as its first
 * entry, so the same URL can hand you two different tables depending on the asset it returns. Any
 * lookup keyed on the number silently assigns the wrong role to a real, ranked player, and it does
 * so silently: no error, no log line, just a member wearing the wrong colour. Tier NAMES are the
 * only durable key Riot publishes, so this module is the single place a tier is identified and the
 * provider deliberately throws the id away.
 *
 * `tiers.test.ts` enforces the invariant mechanically by scanning this feature for numeric tier
 * references, so a future "optimisation" cannot reintroduce an id mapping.
 *
 * 26 ROLES: Unranked, eight three-step divisions (24 steps) and Radiant. The 24 is the number of
 * ranked *steps*, not the number of ranked tiers — counting the divisions alone and forgetting
 * Radiant is a well-worn way to ship a catalog that is one role short.
 *
 * Source of the colour values: `https://valorant-api.com/v1/competitivetiers` (see the note above
 * about which table that endpoint happens to serve).
 */

/** One entry of the competitive ladder. */
export interface RankTier {
  /** Normalized name: lowercase, single-spaced. The lookup key. */
  readonly key: string;
  /** Name as it should appear on the Discord role, e.g. `Ascendant 2`. */
  readonly name: string;
  /** Position on the ladder. `0` is Unranked, `25` is Radiant. */
  readonly order: number;
  /** Tier colour as published by valorant-api.com, without the alpha byte. */
  readonly colorHex: string;
  /** `colorHex` as the integer Discord expects for a role colour. */
  readonly color: number;
  /** True for the single catch-all entry, false for every ranked division. */
  readonly unranked: boolean;
}

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

/**
 * Converts a published tier colour into the integer Discord expects.
 *
 * Tolerates a leading `#` and an optional trailing alpha byte (`ff6ae2af`), because both forms
 * appear in community tier dumps and a bad colour is a silent visual bug rather than an error.
 *
 * @throws if the value is not a 6- or 8-digit hex colour.
 */
export function roleColorFromHex(hex: string): number {
  const trimmed = hex.trim();
  if (!HEX_PATTERN.test(trimmed)) {
    throw new TypeError(`"${hex}" is not a role colour: expected 6 or 8 hex digits.`);
  }
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const rgb = digits.length === 8 ? digits.slice(2) : digits;
  return Number.parseInt(rgb, 16);
}

/**
 * Folds a tier name into its lookup key.
 *
 * Case and whitespace are the only variations seen in the wild — Riot returns `ASCENDANT 2` from
 * some endpoints and `Ascendant 2` from others — so normalisation lowercases and squeezes runs of
 * whitespace into a single space. Nothing else is rewritten: silently repairing a near-miss name
 * would turn "this tier does not exist" into "the wrong role got assigned".
 */
export function normalizeTierName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

interface TierSeed {
  readonly name: string;
  readonly colorHex: string;
  /** Unranked is the only entry that is not part of a three-step division. */
  readonly unranked?: boolean;
}

/**
 * The ladder, lowest first.
 *
 * The order of this array IS the contract: `order` is the index, and the tests assert the array is
 * exactly 25 entries long with no gaps, so a tier cannot be forgotten without the suite failing.
 */
const TIER_SEEDS: readonly TierSeed[] = [
  { name: 'Unranked', colorHex: '868986', unranked: true },
  { name: 'Iron 1', colorHex: '4f514f' },
  { name: 'Iron 2', colorHex: '4f514f' },
  { name: 'Iron 3', colorHex: '4f514f' },
  { name: 'Bronze 1', colorHex: 'a5855d' },
  { name: 'Bronze 2', colorHex: 'a5855d' },
  { name: 'Bronze 3', colorHex: 'a5855d' },
  { name: 'Silver 1', colorHex: 'bbc2c2' },
  { name: 'Silver 2', colorHex: 'bbc2c2' },
  { name: 'Silver 3', colorHex: 'bbc2c2' },
  { name: 'Gold 1', colorHex: 'eccf56' },
  { name: 'Gold 2', colorHex: 'eccf56' },
  { name: 'Gold 3', colorHex: 'eccf56' },
  { name: 'Platinum 1', colorHex: '59a9b6' },
  { name: 'Platinum 2', colorHex: '59a9b6' },
  { name: 'Platinum 3', colorHex: '59a9b6' },
  { name: 'Diamond 1', colorHex: 'b489c4' },
  { name: 'Diamond 2', colorHex: 'b489c4' },
  { name: 'Diamond 3', colorHex: 'b489c4' },
  { name: 'Ascendant 1', colorHex: '6ae2af' },
  { name: 'Ascendant 2', colorHex: '6ae2af' },
  { name: 'Ascendant 3', colorHex: '6ae2af' },
  { name: 'Immortal 1', colorHex: 'bb3d65' },
  { name: 'Immortal 2', colorHex: 'bb3d65' },
  { name: 'Immortal 3', colorHex: 'bb3d65' },
  { name: 'Radiant', colorHex: 'ffffaa' },
];

/** Every tier, ordered from Unranked to Radiant. */
export const RANKS: readonly RankTier[] = TIER_SEEDS.map((seed, order) => ({
  key: normalizeTierName(seed.name),
  name: seed.name,
  order,
  colorHex: seed.colorHex,
  color: roleColorFromHex(seed.colorHex),
  unranked: seed.unranked === true,
}));

const RANKS_BY_KEY: ReadonlyMap<string, RankTier> = new Map(RANKS.map((tier) => [tier.key, tier]));

/** The tier assigned when the provider reports no competitive rank at all. */
export const UNRANKED: RankTier = RANKS[0] as RankTier;

/**
 * Resolves a tier from the name the provider returned.
 *
 * Accepts a missing or empty name and answers Unranked, because "this account has no competitive
 * rank" is a normal state, not an error. Returns `null` only for a name that is present but
 * unrecognised — the caller must surface that rather than guess, since guessing is how the wrong
 * role gets assigned.
 */
export function findTierByName(name: string | null | undefined): RankTier | null {
  if (name === null || name === undefined) {
    return UNRANKED;
  }
  const key = normalizeTierName(name);
  if (key === '') {
    return UNRANKED;
  }
  return RANKS_BY_KEY.get(key) ?? null;
}

/** True when the name resolves to a real tier. */
export function isKnownTierName(name: string | null | undefined): boolean {
  return findTierByName(name) !== null;
}

/**
 * Compares two tiers by ladder position.
 *
 * Exported so tests can assert the catalog is a complete total order (`sort` with this comparator
 * must reproduce `RANKS` exactly) instead of hard-coding 26 expected names twice.
 */
export function compareTiers(left: RankTier, right: RankTier): number {
  return left.order - right.order;
}
