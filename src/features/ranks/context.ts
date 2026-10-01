/**
 * Where the feature gets its provider.
 *
 * The registry builds features with no configuration argument — that is what keeps "add a folder"
 * the whole extension path — so this module is the single seam between the ranks feature and the
 * environment. Two consequences shape it:
 *
 *   - It reads LAZILY and memoizes. The process entrypoint loads dotenv before features are
 *     imported, but a unit test imports this module directly with no `.env` at all, so an
 *     import-time read would freeze "not configured" into every test that touches the UI. Reading
 *     on first use means the same module works in both.
 *   - The value is read ONCE per process. A key that changed mid-run would mean half the members
 *     were looked up under one credential and half under another, and the provider would be the
 *     place that inconsistency showed up.
 *
 * The key is never logged, never echoed and never attached to an error.
 */

import { HenrikDevRankProvider, type RankProvider } from './provider.js';

/** How the provider reads the environment. Overridable so tests never depend on the real `.env`. */
export interface RankContextOptions {
  /** Defaults to `process.env`. */
  readonly readApiKey?: () => string | undefined;
  readonly fetchImpl?: typeof fetch;
}

let readApiKey: () => string | undefined = () => process.env['HENRIK_DEV_API_KEY'];
let fetchImpl: typeof fetch | undefined;
let provider: RankProvider | null = null;

/** Whether rank lookups can run. The UI uses this to explain setup instead of failing on use. */
export function isRankProviderConfigured(): boolean {
  const key = readApiKey();
  return key !== undefined && key.trim() !== '';
}

/**
 * The process-wide provider.
 *
 * @throws {RankProviderNotConfiguredError} when no key is configured, so a caller that skipped
 *         `isRankProviderConfigured` still gets an actionable error rather than a 401.
 */
export function getRankProvider(): RankProvider {
  if (provider === null) {
    const options = { apiKey: readApiKey() ?? null, ...(fetchImpl === undefined ? {} : { fetchImpl }) };
    provider = new HenrikDevRankProvider(options);
  }
  return provider;
}

/** Replaces the environment source and clears the memoized provider. Test-only. */
export function configureRankContext(options: RankContextOptions): void {
  readApiKey = options.readApiKey ?? ((): string | undefined => process.env['HENRIK_DEV_API_KEY']);
  fetchImpl = options.fetchImpl;
  provider = null;
}

/** Drops the memoized provider so the next call re-reads the environment. Test-only. */
export function resetRankContext(): void {
  readApiKey = (): string | undefined => process.env['HENRIK_DEV_API_KEY'];
  fetchImpl = undefined;
  provider = null;
}
