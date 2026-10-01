/**
 * Process entrypoint.
 *
 * This is the only module that reads the real environment and logs into the gateway.
 * Everything it touches is exported and pure enough to be unit tested elsewhere.
 */

import { createBot } from './client/bot.js';
import { formatEnvIssues, loadEnv } from './config/env.js';
import { getDatabase, readDatabasePath } from './core/db.js';
import { createChildLogger } from './core/logger.js';
import { loadFeatures, resolveFeaturesDir } from './core/registry.js';

function reportStartupFailure(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\nUnexpected startup failure:\n${detail}\n\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.ok) {
    // Every problem at once, with remediation, instead of a raw ZodError dump.
    process.stderr.write(`\n${formatEnvIssues(env.issues)}\n\n`);
    process.exitCode = 1;
    return;
  }

  const log = createChildLogger({ scope: 'main' }, env.config.logLevel);
  const featuresDir = resolveFeaturesDir();
  const features = await loadFeatures(featuresDir);

  if (features.length === 0) {
    log.error(
      { featuresDir },
      'no features found: add a folder under src/features/ that default-exports a Feature',
    );
    process.exitCode = 1;
    return;
  }

  // Opened and migrated HERE, before login, even though the stores would open it lazily anyway.
  // A database that cannot be opened or a schema this build cannot understand has to be a startup
  // failure the operator reads in the log — not a `Something went wrong` in a channel, the first
  // time somebody happens to run `/menu`. The path is logged because "which file is it actually
  // using" is the first question when a link appears to have vanished, and it is not guessable.
  try {
    getDatabase();
    log.info({ database: readDatabasePath() }, 'database ready');
  } catch (error) {
    log.error({ err: error, database: readDatabasePath() }, 'database could not be opened or migrated');
    process.exitCode = 1;
    return;
  }

  const bot = createBot(env.config, features);
  try {
    await bot.client.login(env.config.token);
  } catch (error) {
    log.error({ err: error }, 'login failed: check DISCORD_TOKEN and that the application has a bot user');
    process.exitCode = 1;
    bot.dispose();
  }
}

main().catch(reportStartupFailure);
