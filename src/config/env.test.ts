import { describe, expect, it } from 'vitest';

import { DEFAULT_RANK_SYNC_INTERVAL_MINUTES, formatEnvIssues, validateEnv, validateInstallLinkEnv } from './env.js';

const VALID_ENV = {
  DISCORD_TOKEN: 'token-value',
  DISCORD_CLIENT_ID: '123456789012345678',
} as const;

function issuesOf(input: unknown): { variable: string; problem: string; hint: string | null }[] {
  const result = validateEnv(input);
  if (result.ok) {
    throw new Error('expected validation to fail, but it succeeded');
  }
  return [...result.issues];
}

function configOf(input: unknown) {
  const result = validateEnv(input);
  if (!result.ok) {
    throw new Error(`expected validation to succeed: ${formatEnvIssues(result.issues)}`);
  }
  return result.config;
}

describe('validateEnv', () => {
  it('accepts a minimal environment and applies every default', () => {
    expect(configOf(VALID_ENV)).toEqual({
      token: 'token-value',
      clientId: '123456789012345678',
      devGuildId: null,
      logLevel: 'info',
      enablePrivilegedIntents: false,
      henrikDevApiKey: null,
      rankSyncIntervalMinutes: DEFAULT_RANK_SYNC_INTERVAL_MINUTES,
    });
  });

  it('reports every missing variable in a single pass, not one per run', () => {
    expect(issuesOf({}).map((issue) => issue.variable)).toEqual(['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']);
  });

  it('attaches a remediation hint to every issue', () => {
    for (const issue of issuesOf({})) {
      expect(issue.hint).not.toBeNull();
      expect(issue.hint).toContain('Developer Portal');
    }
  });

  it('collects independent problems instead of stopping at the first', () => {
    const issues = issuesOf({
      DISCORD_TOKEN: '   ',
      DISCORD_CLIENT_ID: 'not-a-snowflake',
      LOG_LEVEL: 'verbose',
    });
    expect(issues.map((issue) => `${issue.variable}: ${issue.problem}`)).toEqual([
      'DISCORD_TOKEN: must not be empty',
      'DISCORD_CLIENT_ID: must be a numeric Discord snowflake',
      'LOG_LEVEL: must be one of: trace, debug, info, warn, error, fatal, silent',
    ]);
  });

  it('rejects a client id that is not a snowflake', () => {
    expect(issuesOf({ ...VALID_ENV, DISCORD_CLIENT_ID: '12345' })[0]?.problem).toBe(
      'must be a numeric Discord snowflake',
    );
  });

  it('keeps an optional guild id and rejects a malformed one', () => {
    expect(configOf({ ...VALID_ENV, DISCORD_DEV_GUILD_ID: '987654321098765432' }).devGuildId).toBe(
      '987654321098765432',
    );
    expect(issuesOf({ ...VALID_ENV, DISCORD_DEV_GUILD_ID: 'home' })[0]?.variable).toBe(
      'DISCORD_DEV_GUILD_ID',
    );
  });

  it('accepts every documented log level', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const) {
      expect(configOf({ ...VALID_ENV, LOG_LEVEL: level }).logLevel).toBe(level);
    }
  });

  it('parses the privileged-intent opt-in from the accepted literals', () => {
    for (const literal of ['true', '1', 'yes'] as const) {
      expect(configOf({ ...VALID_ENV, ENABLE_PRIVILEGED_INTENTS: literal }).enablePrivilegedIntents).toBe(
        true,
      );
    }
    for (const literal of ['false', '0', 'no'] as const) {
      expect(configOf({ ...VALID_ENV, ENABLE_PRIVILEGED_INTENTS: literal }).enablePrivilegedIntents).toBe(
        false,
      );
    }
  });

  it('rejects a privileged-intent value that is not a recognised literal', () => {
    expect(issuesOf({ ...VALID_ENV, ENABLE_PRIVILEGED_INTENTS: 'maybe' })[0]?.variable).toBe(
      'ENABLE_PRIVILEGED_INTENTS',
    );
  });

  it('trims surrounding whitespace from secrets', () => {
    expect(configOf({ ...VALID_ENV, DISCORD_TOKEN: '  token-value  ' }).token).toBe('token-value');
  });

  it('ignores unrelated variables instead of failing on them', () => {
    expect(configOf({ ...VALID_ENV, PATH: 'C:\\Windows', NODE_ENV: 'test' }).clientId).toBe(
      '123456789012345678',
    );
  });
});

describe('the optional rank provider key', () => {
  it('stays null when it is absent, so the ranks feature can stay inert', () => {
    expect(configOf(VALID_ENV).henrikDevApiKey).toBeNull();
  });

  it('keeps a configured key, trimmed', () => {
    expect(configOf({ ...VALID_ENV, HENRIK_DEV_API_KEY: '  key-123  ' }).henrikDevApiKey).toBe('key-123');
  });

  it('never requires it, so a bot without ranks still boots', () => {
    const result = validateEnv(VALID_ENV);
    expect(result.ok).toBe(true);
  });

  it('reports a blank value instead of pretending the feature is off', () => {
    // `HENRIK_DEV_API_KEY=` is a copy/paste that lost the value, not an opt-out. Swallowing it
    // would surface as a rank lookup that silently never works.
    const issues = issuesOf({ ...VALID_ENV, HENRIK_DEV_API_KEY: '   ' });
    expect(issues[0]?.variable).toBe('HENRIK_DEV_API_KEY');
    expect(issues[0]?.problem).toMatch(/delete the line/);
    expect(issues[0]?.hint).toContain('henrikdev.xyz');
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The automatic rank sync interval                                                                */
/* -------------------------------------------------------------------------------------------- */

describe('RANK_SYNC_INTERVAL_MINUTES', () => {
  it('defaults to twelve hours, so an unconfigured bot still keeps ranks current', () => {
    // The default has to be a working value, not a "disabled" sentinel: this is a feature the plan
    // asked for and a bot that silently never refreshed ranks would be the bug, not the default.
    expect(DEFAULT_RANK_SYNC_INTERVAL_MINUTES).toBe(720);
    expect(configOf(VALID_ENV).rankSyncIntervalMinutes).toBe(720);
  });

  it('keeps a valid whole number of minutes', () => {
    expect(configOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '30' }).rankSyncIntervalMinutes).toBe(30);
    expect(configOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '1440' }).rankSyncIntervalMinutes).toBe(1440);
  });

  it('trims whitespace, so a pasted value is not read as a syntax error', () => {
    expect(configOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '  60  ' }).rankSyncIntervalMinutes).toBe(60);
  });

  it('rejects zero, because an interval of zero would spin the scheduler', () => {
    // Not defaulted to something sensible either. A zero here means the operator thought they were
    // switching something off, and quietly refreshing on a timer instead is the opposite.
    const issues = issuesOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '0' });
    expect(issues[0]?.variable).toBe('RANK_SYNC_INTERVAL_MINUTES');
    expect(issues[0]?.problem).toBe('must be a positive whole number of minutes');
  });

  it('rejects a negative interval, which would make every account due forever', () => {
    const issues = issuesOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '-5' });
    expect(issues[0]?.variable).toBe('RANK_SYNC_INTERVAL_MINUTES');
    expect(issues[0]?.problem).toBe('must be a positive whole number of minutes');
  });

  it('rejects a non-numeric value with a message that names the variable, not NaN', () => {
    const issues = issuesOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: 'twelve' });
    expect(issues[0]?.variable).toBe('RANK_SYNC_INTERVAL_MINUTES');
    expect(issues[0]?.problem).toBe('must be a positive whole number of minutes');
    expect(issues[0]?.hint).toContain('Default: 720');
  });

  it('rejects a fractional value rather than rounding it silently', () => {
    // 12.5 minutes has no meaning here, and rounding it would leave the operator believing they
    // configured something other than what the bot runs.
    expect(issuesOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '12.5' })[0]?.variable).toBe(
      'RANK_SYNC_INTERVAL_MINUTES',
    );
  });

  it('reports a blank value instead of answering it with the default', () => {
    // `RANK_SYNC_INTERVAL_MINUTES=` is a copy/paste that lost the number. Defaulting it would hide
    // the mistake behind a bot that looks correctly configured.
    const issues = issuesOf({ ...VALID_ENV, RANK_SYNC_INTERVAL_MINUTES: '  ' });
    expect(issues[0]?.variable).toBe('RANK_SYNC_INTERVAL_MINUTES');
    expect(issues[0]?.problem).toBe('must be a positive whole number of minutes');
  });
});

describe('formatEnvIssues', () => {
  it('lists every variable with its problem and hint', () => {
    const rendered = formatEnvIssues(issuesOf({}));
    expect(rendered).toContain('Invalid environment configuration:');
    expect(rendered).toContain('- DISCORD_TOKEN: is required');
    expect(rendered).toContain('- DISCORD_CLIENT_ID: is required');
    expect(rendered).toContain('Copy .env.example to .env');
  });
});

describe('validateInstallLinkEnv', () => {
  it('needs only the client id, so the invite script works without a bot token', () => {
    const result = validateInstallLinkEnv({ DISCORD_CLIENT_ID: '123456789012345678' });
    expect(result).toEqual({ ok: true, clientId: '123456789012345678' });
  });

  it('reports a missing client id', () => {
    const result = validateInstallLinkEnv({});
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected validation to fail');
    }
    expect(result.issues.map((issue) => issue.variable)).toEqual(['DISCORD_CLIENT_ID']);
  });
});
