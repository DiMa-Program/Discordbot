import { describe, expect, it } from 'vitest';

import {
  AFFINITIES,
  affinityCandidates,
  FALLBACK_AFFINITIES,
  inferAffinityFromTag,
  isAffinity,
  resolvePlatform,
} from './regions.js';

describe('the affinity union', () => {
  it('is exactly the six regions the API accepts', () => {
    // Anything outside this list is error code 6, which is our bug and never the user's.
    expect([...AFFINITIES]).toEqual(['na', 'latam', 'br', 'eu', 'ap', 'kr']);
  });

  it('rejects the strings people actually see in the game client', () => {
    // Latin America South is `latam`. `LAS`, `LA`, `oce`, `amer` and `pbe` are all error code 6.
    for (const wrong of ['las', 'la', 'oce', 'amer', 'pbe', 'LATAM', 'NA', '']) {
      expect(isAffinity(wrong)).toBe(false);
    }
  });

  it('accepts only the lowercase canonical form', () => {
    for (const affinity of AFFINITIES) {
      expect(isAffinity(affinity)).toBe(true);
    }
  });
});

describe('inferAffinityFromTag', () => {
  it('maps every European tag family to eu', () => {
    for (const tag of ['EU1', 'EU2', 'EU3', 'eu1', ' Eu1 ']) {
      expect(inferAffinityFromTag(tag)).toBe('eu');
    }
  });

  it('maps every North American tag to na', () => {
    for (const tag of ['NA1', 'NA2', 'NA3', 'na1']) {
      expect(inferAffinityFromTag(tag)).toBe('na');
    }
  });

  it('maps AP, KR and BR to their own shards', () => {
    expect(inferAffinityFromTag('AP1')).toBe('ap');
    expect(inferAffinityFromTag('KR1')).toBe('kr');
    expect(inferAffinityFromTag('BR1')).toBe('br');
  });

  it('maps the Latin American tag families to latam', () => {
    // The live-verified account is Dipplox#LPARG, and its shard is latam.
    for (const tag of ['LP1', 'LPARG', 'LAT1', 'LATAM', 'LBR1', 'lp1']) {
      expect(inferAffinityFromTag(tag)).toBe('latam');
    }
  });

  it('does not let a shorter family shadow a longer one', () => {
    expect(inferAffinityFromTag('LBR1')).toBe('latam');
    expect(inferAffinityFromTag('LAT1')).toBe('latam');
  });

  it('answers null for a tag it does not recognise', () => {
    for (const tag of ['', 'ZZ9', 'MGL', '1234', 'E', 'NOPE']) {
      expect(inferAffinityFromTag(tag)).toBeNull();
    }
  });
});

describe('affinityCandidates', () => {
  it('puts the inferred region first', () => {
    expect(affinityCandidates('EU1')[0]).toBe('eu');
    expect(affinityCandidates('NA3')[0]).toBe('na');
    expect(affinityCandidates('AP1')[0]).toBe('ap');
  });

  it('leads with latam for a Latin American tag, so the guess is right first time', () => {
    expect(affinityCandidates('LPARG')).toEqual(['latam', 'na', 'eu', 'ap', 'kr', 'br']);
  });

  it('leads with na for a North American tag and keeps latam as the rescue shard', () => {
    // Riot's na shard also resolves LATAM and BR accounts, which is what saves a wrong guess.
    expect(affinityCandidates('NA1')).toEqual(['na', 'latam', 'eu', 'ap', 'kr', 'br']);
  });

  it('returns every affinity exactly once', () => {
    for (const tag of ['EU1', 'NA1', 'AP1', 'KR1', 'BR1', 'LPARG', 'unheard-of']) {
      const candidates = affinityCandidates(tag);
      expect(new Set(candidates).size).toBe(candidates.length);
      expect([...candidates].sort()).toEqual([...AFFINITIES].sort());
    }
  });

  it('falls back to the whole list for an unrecognised tag', () => {
    expect(affinityCandidates('ZZ9')).toEqual([...FALLBACK_AFFINITIES]);
    expect(affinityCandidates('')).toEqual([...FALLBACK_AFFINITIES]);
  });

  it('leads the fallback with latam then na, for the South American case', () => {
    expect([...FALLBACK_AFFINITIES]).toEqual(['latam', 'na', 'eu', 'ap', 'kr', 'br']);
  });

  it('never returns a value outside the closed union', () => {
    for (const tag of ['EU1', 'NA1', 'AP1', 'KR1', 'BR1', 'LPARG', '??']) {
      for (const candidate of affinityCandidates(tag)) {
        expect(isAffinity(candidate)).toBe(true);
      }
    }
  });
});

describe('resolvePlatform', () => {
  it('accepts console and defaults everything else to pc', () => {
    expect(resolvePlatform('console')).toBe('console');
    expect(resolvePlatform('pc')).toBe('pc');
    expect(resolvePlatform(undefined)).toBe('pc');
    expect(resolvePlatform('CONSOLE')).toBe('pc');
  });
});
