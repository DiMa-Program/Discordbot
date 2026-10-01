/**
 * Environment configuration.
 *
 * The validation here is a PURE function: it takes an untrusted object and returns either a
 * fully typed config or a list of actionable issues. Nothing in this module reads
 * `process.env`, so it can be imported and unit tested with no `.env` file on disk.
 *
 * Only `loadEnv` and `loadInstallLinkEnv` touch the real environment, and only the process
 * entrypoint and the maintenance scripts call them. dotenv is silenced because the validation
 * errors below already say exactly what to do; dotenv's own "injected env" line adds noise.
 */

import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

/** Log levels accepted by `LOG_LEVEL`, ordered from most to least verbose. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Literals accepted for boolean environment variables. */
export const BOOLEAN_LITERALS = ['true', 'false', '1', '0', 'yes', 'no'] as const;
export type BooleanLiteral = (typeof BOOLEAN_LITERALS)[number];

/** Discord snowflakes are numeric strings of 17 to 20 digits. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/**
 * Remediation text per variable. Attached to every issue so a failure tells the reader
 * exactly where to look instead of only what went wrong.
 */
const HINTS: Readonly<Record<string, string>> = {
  DISCORD_TOKEN:
    'Copy .env.example to .env, then paste the token from Discord Developer Portal > Bot > Reset Token.',
  DISCORD_CLIENT_ID:
    'Copy the Application ID from Discord Developer Portal > General Information > Application ID.',
  DISCORD_DEV_GUILD_ID:
    'Optional. Right-click your server in Discord > Copy Server ID (enable Developer Mode first). Unset means global commands.',
  LOG_LEVEL: `Optional. One of: ${LOG_LEVELS.join(', ')}.`,
  ENABLE_PRIVILEGED_INTENTS:
    'Optional. "true" also requests the privileged gateway intents that features declare. Those must additionally be ticked in Discord Developer Portal > Bot > Privileged Gateway Intents.',
  HENRIK_DEV_API_KEY:
    'Optional. Delete the line entirely to run without the ranks feature. If you keep it, it must hold a real key from https://henrikdev.xyz/account, never a blank value.',
};

function toBoolean(literal: string): boolean {
  return literal === 'true' || literal === '1' || literal === 'yes';
}

/**
 * Schema for the values the running bot needs.
 *
 * The short problem strings ("is required", "must not be empty") are intentionally terse:
 * `formatEnvIssues` appends the hint that tells the reader how to fix them.
 */
const envSchema = z.object({
  DISCORD_TOKEN: z.string({ error: 'is required' }).trim().min(1, 'must not be empty'),
  DISCORD_CLIENT_ID: z
    .string({ error: 'is required' })
    .trim()
    .regex(SNOWFLAKE_PATTERN, 'must be a numeric Discord snowflake'),
  DISCORD_DEV_GUILD_ID: z
    .string()
    .trim()
    .regex(SNOWFLAKE_PATTERN, 'must be a numeric Discord snowflake')
    .optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of: ${LOG_LEVELS.join(', ')}` }).default('info'),
  ENABLE_PRIVILEGED_INTENTS: z
    .enum(BOOLEAN_LITERALS, { error: `must be one of: ${BOOLEAN_LITERALS.join(', ')}` })
    .default('false')
    .transform(toBoolean),
  /**
   * Optional on purpose: the bot must boot and serve every other command when it is absent.
   *
   * A blank value is a mistake rather than an absence, so it is reported the same way a blank
   * `DISCORD_TOKEN` is: silently treating `KEY=` as "no key" would hide a copy/paste that lost
   * the value and only surface later as a rank lookup that never works.
   */
  HENRIK_DEV_API_KEY: z
    .string()
    .trim()
    .min(1, 'must not be empty — delete the line instead of leaving it blank')
    .optional(),
});

/**
 * Schema for the OAuth2 install-link script, which builds a URL from the application id alone.
 * Requiring a bot token to print a public install link would be a needless footgun.
 */
const installLinkSchema = z.object({
  DISCORD_CLIENT_ID: z
    .string({ error: 'is required' })
    .trim()
    .regex(SNOWFLAKE_PATTERN, 'must be a numeric Discord snowflake'),
});

/** Validated, app-facing configuration. Secrets are present but never logged. */
export interface EnvConfig {
  readonly token: string;
  readonly clientId: string;
  /** Guild id used for guild-scoped command deployment, or `null` for global deployment. */
  readonly devGuildId: string | null;
  readonly logLevel: LogLevel;
  readonly enablePrivilegedIntents: boolean;
  /**
   * Key for the third-party rank provider, or `null` when the operator did not configure one.
   *
   * Consumers must treat `null` as "this feature is switched off" and stay inert rather than
   * failing: an optional dependency may never take the whole bot down.
   */
  readonly henrikDevApiKey: string | null;
}

/** A single configuration problem plus the remediation text for it. */
export interface EnvIssue {
  readonly variable: string;
  readonly problem: string;
  readonly hint: string | null;
}

export type EnvValidationResult =
  | { readonly ok: true; readonly config: EnvConfig }
  | { readonly ok: false; readonly issues: readonly EnvIssue[] };

export type InstallLinkValidationResult =
  | { readonly ok: true; readonly clientId: string }
  | { readonly ok: false; readonly issues: readonly EnvIssue[] };

function toIssues(error: z.ZodError): EnvIssue[] {
  return error.issues.map((issue) => {
    const variable = issue.path.map((segment) => String(segment)).join('.') || '(root)';
    return { variable, problem: issue.message, hint: HINTS[variable] ?? null };
  });
}

/**
 * Validates an arbitrary input object against the runtime environment schema.
 *
 * Pure by design: it accepts `unknown` because the real caller is `process.env`, and it is the
 * same function the unit tests call with hand-written fixtures.
 */
export function validateEnv(input: unknown): EnvValidationResult {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: toIssues(parsed.error) };
  }
  return {
    ok: true,
    config: {
      token: parsed.data.DISCORD_TOKEN,
      clientId: parsed.data.DISCORD_CLIENT_ID,
      devGuildId: parsed.data.DISCORD_DEV_GUILD_ID ?? null,
      logLevel: parsed.data.LOG_LEVEL,
      enablePrivilegedIntents: parsed.data.ENABLE_PRIVILEGED_INTENTS,
      henrikDevApiKey: parsed.data.HENRIK_DEV_API_KEY ?? null,
    },
  };
}

/** Validates only what the install-link script needs: the application id. */
export function validateInstallLinkEnv(input: unknown): InstallLinkValidationResult {
  const parsed = installLinkSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: toIssues(parsed.error) };
  }
  return { ok: true, clientId: parsed.data.DISCORD_CLIENT_ID };
}

/**
 * Renders every issue in one block, so a misconfigured environment is fixed in a single pass
 * instead of one variable per run.
 */
export function formatEnvIssues(issues: readonly EnvIssue[]): string {
  const lines: string[] = ['Invalid environment configuration:', ''];
  for (const issue of issues) {
    lines.push(`  - ${issue.variable}: ${issue.problem}`);
    if (issue.hint !== null) {
      lines.push(`      ${issue.hint}`);
    }
  }
  lines.push('', 'Copy .env.example to .env, fill in the values above, then re-run the command.');
  return lines.join('\n');
}

/** Loads `.env` (if present) and validates the environment the bot needs to run. */
export function loadEnv(): EnvValidationResult {
  loadDotenvFile({ quiet: true });
  return validateEnv(process.env);
}

/** Loads `.env` (if present) and validates only the application id. */
export function loadInstallLinkEnv(): InstallLinkValidationResult {
  loadDotenvFile({ quiet: true });
  return validateInstallLinkEnv(process.env);
}
