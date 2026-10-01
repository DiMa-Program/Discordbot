/**
 * Structured logging.
 *
 * A single pino instance for the process plus a child-logger helper, so every line carries the
 * scope it came from. Anything that looks like a credential is redacted before it reaches a
 * transport, because bot tokens leak easily through accidental object logging.
 */

import { pino } from 'pino';
import type { Logger } from 'pino';
import type { LogLevel } from '../config/env.js';

export type { Logger };

/**
 * Paths pino censors. Covers both a bare `token` and the REST client's own option bag.
 *
 * The third-party provider key is listed by name as well as by shape. Nothing in the ranks feature
 * logs it, but `EnvConfig` now carries it, so a `log.info({ config })` anywhere in the project
 * would otherwise publish it in cleartext. Censoring the known field names means a future logging
 * mistake cannot become a credential leak.
 */
export const REDACTED_PATHS: readonly string[] = [
  'token',
  '*.token',
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'client.options.token',
  'apiKey',
  '*.apiKey',
  'henrikDevApiKey',
  '*.henrikDevApiKey',
  'HENRIK_DEV_API_KEY',
  '*.HENRIK_DEV_API_KEY',
];

function loggerOptions(level: LogLevel): Record<string, unknown> {
  return {
    level,
    base: { service: 'discordbot' },
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
  };
}

/** Creates the root logger. */
export function createLogger(level: LogLevel = 'info'): Logger {
  return pino(loggerOptions(level));
}

/** Creates a logger that stamps every line with the supplied bindings. */
export function createChildLogger(bindings: Record<string, unknown>, level: LogLevel = 'info'): Logger {
  return createLogger(level).child(bindings);
}
