import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareTiers,
  findTierByName,
  isKnownTierName,
  normalizeTierName,
  RANKS,
  roleColorFromHex,
  UNRANKED,
} from './tiers.js';

const EXPECTED_NAMES = [
  'Unranked',
  'Iron 1',
  'Iron 2',
  'Iron 3',
  'Bronze 1',
  'Bronze 2',
  'Bronze 3',
  'Silver 1',
  'Silver 2',
  'Silver 3',
  'Gold 1',
  'Gold 2',
  'Gold 3',
  'Platinum 1',
  'Platinum 2',
  'Platinum 3',
  'Diamond 1',
  'Diamond 2',
  'Diamond 3',
  'Ascendant 1',
  'Ascendant 2',
  'Ascendant 3',
  'Immortal 1',
  'Immortal 2',
  'Immortal 3',
  'Radiant',
] as const;

describe('the rank catalog', () => {
  it('holds Unranked, 24 ranked steps across 8 divisions, and Radiant', () => {
    // The trap: "24" is the number of ranked STEPS, not the number of ranked tiers. Counting the
    // divisions and forgetting Radiant ships a catalog one role short.
    expect(RANKS).toHaveLength(26);
    expect(RANKS.filter((tier) => tier.unranked)).toHaveLength(1);

    const divisions = new Set(RANKS.filter((tier) => !tier.unranked).map((tier) => tier.name.split(' ')[0]));
    expect(divisions).toEqual(
      new Set(['Iron', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Ascendant', 'Immortal', 'Radiant']),
    );
  });

  it('lists every tier in ladder order, Unranked first and Radiant last', () => {
    expect(RANKS.map((tier) => tier.name)).toEqual([...EXPECTED_NAMES]);
  });

  it('numbers the ladder with no gaps, so a forgotten tier fails the suite', () => {
    expect(RANKS.map((tier) => tier.order)).toEqual(Array.from({ length: 26 }, (_, index) => index));
  });

  it('is a total order that sorting reproduces', () => {
    const shuffled = [...RANKS].reverse();
    expect([...shuffled].sort(compareTiers).map((tier) => tier.name)).toEqual([...EXPECTED_NAMES]);
  });

  it('gives every division exactly three steps except Unranked and Radiant', () => {
    const counts = new Map<string, number>();
    for (const tier of RANKS) {
      const division = tier.unranked ? 'Unranked' : (tier.name.split(' ')[0] ?? '');
      counts.set(division, (counts.get(division) ?? 0) + 1);
    }

    expect(Object.fromEntries(counts)).toEqual({
      Unranked: 1,
      Iron: 3,
      Bronze: 3,
      Silver: 3,
      Gold: 3,
      Platinum: 3,
      Diamond: 3,
      Ascendant: 3,
      Immortal: 3,
      Radiant: 1,
    });
  });

  it('gives every tier a distinct lookup key', () => {
    expect(new Set(RANKS.map((tier) => tier.key)).size).toBe(RANKS.length);
  });

  it('uses the published colour for every division', () => {
    const expected: Readonly<Record<string, string>> = {
      Iron: '4f514f',
      Bronze: 'a5855d',
      Silver: 'bbc2c2',
      Gold: 'eccf56',
      Platinum: '59a9b6',
      Diamond: 'b489c4',
      Ascendant: '6ae2af',
      Immortal: 'bb3d65',
      Radiant: 'ffffaa',
      Unranked: '868986',
    };

    for (const tier of RANKS) {
      const division = tier.unranked ? 'Unranked' : (tier.name.split(' ')[0] ?? '');
      expect(tier.colorHex).toBe(expected[division]);
      expect(tier.color).toBe(roleColorFromHex(expected[division] ?? ''));
    }
  });

  it('carries no alpha byte in any colour', () => {
    for (const tier of RANKS) {
      expect(tier.colorHex).toMatch(/^[0-9a-f]{6}$/);
      expect(tier.color).toBeLessThanOrEqual(0xffffff);
      expect(tier.color).toBeGreaterThan(0);
    }
  });
});

describe('normalizeTierName', () => {
  it('folds case and whitespace so one tier has one key', () => {
    for (const input of ['ASCENDANT 2', 'ascendant 2', 'Ascendant 2', '  Ascendant   2  ', 'Ascendant\t2']) {
      expect(normalizeTierName(input)).toBe('ascendant 2');
    }
  });

  it('trims without lowercasing the value it was given', () => {
    expect(normalizeTierName('  Radiant  ')).toBe('radiant');
  });
});

describe('findTierByName', () => {
  it('resolves every tier in the catalog, in any case', () => {
    for (const tier of RANKS) {
      expect(findTierByName(tier.name)?.name).toBe(tier.name);
      expect(findTierByName(tier.name.toUpperCase())?.name).toBe(tier.name);
      expect(findTierByName(`  ${tier.name.toLowerCase()} `)?.name).toBe(tier.name);
    }
  });

  it('resolves the live-verified example, Ascendant 2, whatever the endpoint casing', () => {
    // The provider returned "ASCENDANT 2" for this account; the role must be Ascendant 2.
    expect(findTierByName('ASCENDANT 2')?.order).toBe(20);
    expect(findTierByName('ASCENDANT 2')?.name).toBe('Ascendant 2');
  });
  it('treats a missing or empty name as Unranked rather than an error', () => {
    expect(findTierByName(null)).toBe(UNRANKED);
    expect(findTierByName(undefined)).toBe(UNRANKED);
    expect(findTierByName('   ')).toBe(UNRANKED);
  });

  it('answers null for a name it does not know instead of guessing', () => {
    expect(findTierByName('Ascendant 4')).toBeNull();
    expect(findTierByName('Ascendant2')).toBeNull();
    expect(findTierByName('Platinum 4')).toBeNull();
    expect(findTierByName('Grandmaster')).toBeNull();
    expect(isKnownTierName('Grandmaster')).toBe(false);
  });
});

describe('roleColorFromHex', () => {
  it('converts to the integer Discord expects', () => {
    expect(roleColorFromHex('6ae2af')).toBe(0x6ae2af);
    expect(roleColorFromHex('868986')).toBe(0x868986);
  });

  it('accepts a leading hash and an alpha byte', () => {
    expect(roleColorFromHex('#6AE2AF')).toBe(0x6ae2af);
    expect(roleColorFromHex('ff6ae2af')).toBe(0x6ae2af);
  });

  it('refuses anything that is not a colour, rather than yielding a wrong one', () => {
    for (const bad of ['', '6ae2a', 'zzzzzz', '6ae2af8f8', '0x6ae2af']) {
      expect(() => roleColorFromHex(bad)).toThrow(/not a role colour/);
    }
  });
});

describe('the no-numeric-tier-id invariant', () => {
  const ranksDir = path.dirname(fileURLToPath(import.meta.url));

  /**
   * The whole point of the catalog is that tiers are keyed by name. A mapping keyed on Riot's
   * numbering would mis-assign a real, ranked player after an episode patch, so the invariant is
   * enforced mechanically over the source instead of trusted to review.
   */
  it('never reads a tier id in any module of the feature', () => {
    const modules = ['tiers.ts', 'provider.ts', 'role-sync.ts', 'view.ts', 'interaction.ts', 'messages.ts', 'store.ts', 'context.ts', 'regions.ts', 'commands/menu.ts', 'commands/rank.ts'];
    for (const moduleName of modules) {
      const source = readFileSync(path.join(ranksDir, moduleName), 'utf8');

      // The provider's payload really does contain a tier id; reading it at all is the failure.
      expect(source, `${moduleName} must not read a tier id`).not.toMatch(/tier\s*[?.!]*\s*\.\s*id/);
      expect(source, `${moduleName} must not map on a numeric tier id`).not.toMatch(/tierId/);
      // 21 used to be IMMORTAL 1 and is now ASCENDANT 1; a literal here is the bug waiting to ship.
      expect(source, `${moduleName} must not hardcode a Riot tier number`).not.toMatch(
        /\b(?:id|tier)\s*[:=]\s*(?:1[0-9]|2[0-4])\b/,
      );
    }
  });

  it('still documents why the id is refused, so the rule survives its explanation', () => {
    const source = readFileSync(path.join(ranksDir, 'tiers.ts'), 'utf8');
    expect(source).toMatch(/renumbered/i);
  });
});
