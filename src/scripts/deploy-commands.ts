/**
 * Slash command deployment.
 *
 * Target selection:
 *   - `DISCORD_DEV_GUILD_ID` set: guild-scoped bulk overwrite. Takes effect in about a second,
 *     which is what you want while developing.
 *   - `DISCORD_DEV_GUILD_ID` unset: global commands. Discord propagates these slowly, up to
 *     roughly an hour, so a fresh global command may not appear immediately.
 *
 * Only bulk overwrite (PUT) is used. It reconciles the remote set with the local one, so a
 * command deleted from the code is removed from Discord instead of lingering forever.
 *
 * Before touching the network this script cross-checks the two discovery paths — the feature
 * manifests and the `commands/` tree — and refuses to deploy if they disagree.
 */

import { REST, Routes } from 'discord.js';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

import { formatEnvIssues, loadEnv } from '../config/env.js';
import { createChildLogger } from '../core/logger.js';
import {
  collectSlashCommands,
  createRegistry,
  loadFeatures,
  resolveFeaturesDir,
} from '../core/registry.js';

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.ok) {
    process.stderr.write(`\n${formatEnvIssues(env.issues)}\n\n`);
    process.exitCode = 1;
    return;
  }

  const log = createChildLogger({ scope: 'deploy' }, env.config.logLevel);
  const featuresDir = resolveFeaturesDir();

  const features = await loadFeatures(featuresDir);
  const plan = createRegistry(features, []);
  const discovered = await collectSlashCommands(featuresDir);

  const payload = new Map<string, RESTPostAPIApplicationCommandsJSONBody>();
  for (const { source, command } of discovered) {
    const name = command.data.name;
    const existing = payload.get(name);
    if (existing !== undefined) {
      log.warn({ command: name, keptFrom: existing, ignored: source }, 'duplicate command name on disk');
      continue;
    }
    payload.set(name, command.data);
  }

  // Consistency gate: a command on disk with no manifest entry would be deployed with no
  // handler behind it, and a manifest entry with no file would never be deployed at all.
  const manifestNames = new Set(plan.commands.keys());
  const diskNames = new Set(payload.keys());
  const unregistered = [...diskNames].filter((name) => !manifestNames.has(name));
  const undeployed = [...manifestNames].filter((name) => !diskNames.has(name));
  if (unregistered.length > 0 || undeployed.length > 0) {
    log.error(
      {
        unregistered,
        undeployed,
        hint: 'each command file must be listed in its feature index.ts `commands` array, and vice versa',
      },
      'feature manifests and the commands/ tree disagree: nothing was deployed',
    );
    process.exitCode = 1;
    return;
  }

  const body = [...payload.values()];
  const names = body.map((command) => command.name);
  const rest = new REST({ version: '10' }).setToken(env.config.token);
  const target = env.config.devGuildId;

  if (target === null) {
    log.info({ count: body.length, commands: names }, 'registering global commands (Discord can take up to an hour to propagate)');
    await rest.put(Routes.applicationCommands(env.config.clientId), { body });
  } else {
    log.info({ count: body.length, guildId: target, commands: names }, 'registering guild commands');
    await rest.put(Routes.applicationGuildCommands(env.config.clientId, target), { body });
  }

  log.info('command deployment finished');
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\nCommand deployment failed:\n${detail}\n\n`);
  process.exitCode = 1;
});
