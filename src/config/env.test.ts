import { describe, expect, it } from 'vitest';

import { formatEnvIssues, validateEnv, validateInstallLinkEnv } from './env.js';

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
