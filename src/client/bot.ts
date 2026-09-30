/**
 * Bot bootstrap: client construction, feature wiring, diagnostics and graceful shutdown.
 *
 * GATEWAY INTENTS ARE EXPLICIT AND MINIMAL ON PURPOSE.
 *
 * `Guilds` is mandatory. Without it the client cannot cache guilds or receive guild events.
 * `GuildMessages` is included so message-driven features work with no extra configuration.
 *
 * PRIVILEGED INTENTS REQUIRE A MANUAL DEVELOPER PORTAL TOGGLE.
 * `GuildMembers`, `MessageContent` and `GuildPresences` are disabled by default in
 * Discord Developer Portal > Bot > Privileged Gateway Intents, and enabling them for a bot in
 * 75 or more guilds requires Discord approval. This project therefore never assumes them.
 *
 * A privileged intent is requested only when BOTH conditions hold:
 *   1. `ENABLE_PRIVILEGED_INTENTS=true` is set in `.env`, and
 *   2. a feature actually declares it in `requiredIntents`.
 *
 * That means the bot runs with no portal changes out of the box, and a feature that declares an
 * intent it does not need cannot silently acquire it. When a declared intent is absent,
 * `createRegistry` reports it and `reportPlan` logs a warning at boot.
 */

import { Client, GatewayIntentBits } from 'discord.js';

import type { EnvConfig } from '../config/env.js';
import { createLogger, type Logger } from '../core/logger.js';
import { applyRegistry, createRegistry, type Feature, type RegistryPlan } from '../core/registry.js';

/** Always-on intents. None of these require a portal toggle. */
export const BASE_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
];

/** Intents that stay off unless the operator opts in. See the module comment. */
export const PRIVILEGED_INTENTS: readonly GatewayIntentBits[] = [
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildPresences,
];

const INTENT_NAMES: ReadonlyMap<number, string> = buildIntentNames();

function buildIntentNames(): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  for (const [key, value] of Object.entries(GatewayIntentBits)) {
    if (typeof value === 'number') {
      names.set(value, key);
    }
  }
  return names;
}

/** Renders intents as names for logging, falling back to the raw bit for unknown values. */
export function describeIntents(intents: readonly GatewayIntentBits[]): string {
  return intents.map((intent) => INTENT_NAMES.get(intent) ?? String(intent)).join(', ');
}

/** Union of every intent any feature declared, privileged or not. */
export function collectDeclaredIntents(features: readonly Feature[]): readonly GatewayIntentBits[] {
  const declared = new Set<GatewayIntentBits>();
  for (const feature of features) {
    for (const intent of feature.requiredIntents ?? []) {
      declared.add(intent);
    }
  }
  return [...declared];
}

/**
 * Decides the intent list: the base set, plus declared intents only when privileged access is
 * explicitly enabled.
 */
export function resolveIntents(
  features: readonly Feature[],
  enablePrivilegedIntents: boolean,
): GatewayIntentBits[] {
  const intents = new Set<GatewayIntentBits>(BASE_INTENTS);
  if (enablePrivilegedIntents) {
    for (const intent of collectDeclaredIntents(features)) {
      intents.add(intent);
    }
  }
  return [...intents];
}

/** A constructed bot plus the handles needed to inspect or dispose of it. */
export interface Bot {
  readonly client: Client;
  readonly plan: RegistryPlan;
  readonly intents: readonly GatewayIntentBits[];
  /** Removes the signal handlers registered by `attachShutdownHandlers`. */
  readonly dispose: () => void;
}

function reportPlan(
  log: Logger,
  plan: RegistryPlan,
  intents: readonly GatewayIntentBits[],
): void {
  log.info(
    {
      features: plan.features,
      commands: [...plan.commands.keys()],
      intents: describeIntents(intents),
    },
    'feature registry built',
  );

  for (const duplicate of plan.duplicateCommands) {
    log.warn(
      { command: duplicate.name, features: duplicate.features },
      'duplicate command name: the first registration wins',
    );
  }

  for (const missing of plan.missingIntents) {
    log.warn(
      { feature: missing.feature, intents: describeIntents(missing.intents) },
      'feature declared gateway intents that are not enabled: its event handlers will never fire',
    );
  }

  const blockedPrivileged = plan.missingIntents.flatMap((missing) => missing.intents).filter((intent) =>
    PRIVILEGED_INTENTS.includes(intent),
  );
  if (blockedPrivileged.length > 0) {
    log.warn(
      { intents: describeIntents(blockedPrivileged) },
      'set ENABLE_PRIVILEGED_INTENTS=true in .env AND tick the matching toggles in Discord Developer Portal > Bot > Privileged Gateway Intents',
    );
  }
}

function attachDiagnostics(
  client: Client,
  log: Logger,
  intents: readonly GatewayIntentBits[],
): void {
  client.once('clientReady', (ready) => {
    log.info(
      { tag: ready.user.tag, guilds: ready.guilds.cache.size, intents: describeIntents(intents) },
      'logged in',
    );
  });
  client.on('error', (error) => {
    log.error({ err: error }, 'discord client error');
  });
  client.on('shardError', (error, shardId) => {
    log.error({ err: error, shardId }, 'shard error');
  });
  client.on('warn', (message) => {
    log.warn({ message }, 'discord client warning');
  });
}

/**
 * Destroys the client on SIGINT/SIGTERM, once.
 *
 * Shutdown is not forced with `process.exit`, so buffered log lines are flushed. `Client#destroy`
 * closes the gateway heartbeat and the REST agent, which drains the event loop on its own.
 *
 * @returns a function that removes the handlers again.
 */
export function attachShutdownHandlers(client: Client, log: Logger): () => void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    try {
      await client.destroy();
      log.info('client destroyed');
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exitCode = 1;
    }
  };

  const onInterrupt = (): void => {
    void shutdown('SIGINT');
  };
  const onTerminate = (): void => {
    void shutdown('SIGTERM');
  };

  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  return () => {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  };
}

/** Builds a client, wires the registry, and installs diagnostics and shutdown handling. */
export function createBot(config: EnvConfig, features: readonly Feature[]): Bot {
  const log = createLogger(config.logLevel);

  const intents = resolveIntents(features, config.enablePrivilegedIntents);
  const client = new Client({ intents });
  const plan = createRegistry(features, intents);

  reportPlan(log, plan, intents);
  applyRegistry(client, plan);
  attachDiagnostics(client, log, intents);
  const dispose = attachShutdownHandlers(client, log);

  return { client, plan, intents, dispose };
}
