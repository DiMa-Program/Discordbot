import { beforeEach, describe, expect, it } from 'vitest';

import { isLinked, getLinkedAccount, linkAccount, linkedAccountCount, resetLinkedAccounts, unlinkAccount } from './store.js';

const USER = '111111111111111111';
const OTHER_USER = '222222222222222222';

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
