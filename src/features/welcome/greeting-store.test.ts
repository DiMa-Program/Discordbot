import { beforeEach, describe, expect, it } from 'vitest';

import {
  configureGreeting,
  getGreetingSettings,
  isGreetingEnabled,
  resetGreetingSettings,
} from './greeting-store.js';

const GUILD = '123456789012345678';

beforeEach(() => {
  resetGreetingSettings();
});

describe('greeting store', () => {
  it('is disabled for a guild that never opted in', () => {
    expect(getGreetingSettings(GUILD)).toEqual({ enabled: false, channelId: null });
    expect(isGreetingEnabled(GUILD)).toBe(false);
  });

  it('stays silent when enabled without a target channel', () => {
    configureGreeting(GUILD, { enabled: true, channelId: null });
    expect(isGreetingEnabled(GUILD)).toBe(false);
  });

  it('becomes active only when both the flag and a channel are set', () => {
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    expect(isGreetingEnabled(GUILD)).toBe(true);
  });

  it('disables again but remembers the configured channel', () => {
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    configureGreeting(GUILD, { enabled: false, channelId: '200000000000000001' });
    expect(isGreetingEnabled(GUILD)).toBe(false);
    expect(getGreetingSettings(GUILD).channelId).toBe('200000000000000001');
  });

  it('keeps guilds isolated from one another', () => {
    const other = '987654321098765432';
    configureGreeting(GUILD, { enabled: true, channelId: '200000000000000001' });
    expect(isGreetingEnabled(other)).toBe(false);
  });
});
