/**
 * Feature registry.
 *
 * A feature is a folder under `src/features/` that default-exports a `Feature` object. Nothing
 * in `core/` imports a feature by name, so adding a feature never requires editing a core
 * file: create the folder, deploy the commands, restart the bot.
 *
 * Two independent discovery paths are exposed, and they are expected to agree:
 *   - `loadFeatures` reads each feature's `index` module — the RUNTIME manifest.
 *   - `collectSlashCommands` walks every `commands/` folder — the DEPLOYMENT manifest.
 * `src/scripts/deploy-commands.ts` compares the two so a command that exists on disk but was
 * never registered fails loudly instead of being deployed with no handler behind it.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  GatewayIntentBits,
  Interaction,
  RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js';

import type { Logger } from './logger.js';

/**
 * A slash command: the REST payload that gets deployed, plus the handler that answers it.
 *
 * The data type is the REST body shape rather than a `SlashCommandBuilder`, because
 * `SlashCommandBuilder#toJSON()` produces exactly that and deployment needs the plain object.
 */
export interface SlashCommandWithExecute {
  readonly data: RESTPostAPIApplicationCommandsJSONBody;
  readonly execute: (interaction: ChatInputCommandInteraction) => unknown;
}

/**
 * A single event listener with its arguments type-erased to the union of every event tuple.
 *
 * This is what lets one `EventBinding` list hold listeners for different events. It stays
 * sound because the erasure happens exactly once, at the boundary where a feature's
 * per-event signature is checked by `FeatureHandlers`.
 */
export type FeatureHandler = (...args: ClientEvents[keyof ClientEvents]) => unknown;

/** Handlers a feature may declare, keyed by client event name, each type-checked per event. */
export type FeatureHandlers = {
  [Event in keyof ClientEvents]?: (...args: ClientEvents[Event]) => unknown;
};

/** The contract every folder under `src/features/` must satisfy. */
export interface Feature {
  readonly name: string;
  readonly description?: string;
  readonly commands?: readonly SlashCommandWithExecute[];
  readonly handlers?: FeatureHandlers;
  /**
   * Gateway intents this feature needs. Privileged intents among them are only granted when
   * the operator explicitly opts in, so declaring one is safe by default.
   */
  readonly requiredIntents?: readonly GatewayIntentBits[];
}

/** A listener to attach, tagged with the feature that declared it. */
export interface EventBinding {
  readonly event: keyof ClientEvents;
  readonly feature: string;
  readonly handler: FeatureHandler;
}

/** A command name claimed by more than one feature. The first registration wins. */
export interface DuplicateCommand {
  readonly name: string;
  readonly features: readonly string[];
}

/** Intents a feature declared that the running client is not subscribed to. */
export interface MissingIntents {
  readonly feature: string;
  readonly intents: readonly GatewayIntentBits[];
}

/** Everything the bot needs to wire itself up, computed without touching a Discord client. */
export interface RegistryPlan {
  readonly features: readonly string[];
  readonly commands: ReadonlyMap<string, SlashCommandWithExecute>;
  readonly commandData: readonly RESTPostAPIApplicationCommandsJSONBody[];
  readonly bindings: readonly EventBinding[];
  readonly duplicateCommands: readonly DuplicateCommand[];
  readonly missingIntents: readonly MissingIntents[];
}

/**
 * Folds features into a wiring plan. Pure: no client, no filesystem, no network.
 *
 * Duplicate command names are reported rather than thrown, because two features shipping the
 * same name is a merge mistake the operator should see in the log, not a crash on boot.
 *
 * @param features    feature definitions to register
 * @param activeIntents intents the client will actually subscribe to
 */
export function createRegistry(
  features: readonly Feature[],
  activeIntents: readonly GatewayIntentBits[],
): RegistryPlan {
  const commandOwners = new Map<string, string[]>();
  const commands = new Map<string, SlashCommandWithExecute>();
  const bindings: EventBinding[] = [];
  const duplicateCommands: DuplicateCommand[] = [];
  const missingIntents: MissingIntents[] = [];
  const granted = new Set<GatewayIntentBits>(activeIntents);

  for (const feature of features) {
    for (const command of feature.commands ?? []) {
      const name = command.data.name;
      const previousOwners = commandOwners.get(name) ?? [];
      if (!commands.has(name)) {
        commands.set(name, command);
      }
      if (previousOwners.length > 0) {
        duplicateCommands.push({ name, features: [...previousOwners, feature.name] });
      }
      commandOwners.set(name, [...previousOwners, feature.name]);
    }

    const handlers: FeatureHandlers = feature.handlers ?? {};
    for (const [event, handler] of Object.entries(handlers) as Array<[keyof ClientEvents, unknown]>) {
      if (typeof handler !== 'function') {
        throw new TypeError(`Feature "${feature.name}" declares a non-function handler for "${event}".`);
      }
      bindings.push({ event, feature: feature.name, handler: handler as FeatureHandler });
    }

    const absent = (feature.requiredIntents ?? []).filter((intent) => !granted.has(intent));
    if (absent.length > 0) {
      missingIntents.push({ feature: feature.name, intents: absent });
    }
  }

  return {
    features: features.map((feature) => feature.name),
    commands,
    commandData: [...commands.values()].map((command) => command.data),
    bindings,
    duplicateCommands,
    missingIntents,
  };
}

/**
 * What the user is told when a command handler throws.
 *
 * Deliberately generic: the stack trace, the file path and the original error message go to the
 * log, never to the channel. A bug in a handler should not become a public disclosure.
 */
export const COMMAND_FAILURE_MESSAGE = 'Something went wrong running that command.';

/**
 * Sends the failure notice on whichever channel is still open.
 *
 * Discord allows exactly one acknowledgement per interaction, so the choice is forced: once the
 * handler has replied or deferred, only `followUp` can work; otherwise `reply` is the one that
 * clears the 3-second window that produces "The application did not respond".
 */
async function acknowledgeFailure(interaction: ChatInputCommandInteraction): Promise<void> {
  const content = { content: COMMAND_FAILURE_MESSAGE, ephemeral: true };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(content);
    return;
  }
  await interaction.reply(content);
}

/**
 * The listener signature `interactionCreate` actually emits: `(interaction: Interaction) => void`.
 *
 * Deliberately NOT `FeatureHandler`. That type erases every event tuple into one union, so it
 * includes listeners like `(message: string) => void`; a function that insists on an `Interaction`
 * cannot be assignable to it, and returning it would force a cast that throws the type safety away
 * at exactly the boundary this fix exists to make safe.
 */
export type InteractionRouter = (...args: ClientEvents['interactionCreate']) => void;

/**
 * Builds the `interactionCreate` listener that routes chat-input commands to their handler.
 *
 * This is the bridge between the RUNTIME manifest and Discord. Without it a command can be
 * deployed, appear in the picker, and then do nothing at all — which Discord reports to the user
 * as "The application did not respond", with no clue on the bot side why.
 *
 * Three deliberate choices:
 *   - Anything that is not a chat-input command is returned untouched, so buttons, selects,
 *     autocomplete and modals stay available for features that bind their own listeners.
 *   - An unknown command name is logged, not thrown. By the time an interaction arrives, the
 *     deploy gate has already proved the two discovery paths agree, so a miss here means a
 *     command was deployed out of band; crashing the whole process over it helps nobody.
 *   - A throwing handler is answered, not propagated. Letting the rejection escape would restore
 *     the exact symptom this function exists to remove.
 *
 * On success the router replies to nothing: acknowledging the interaction is the handler's job,
 * and replying here as well would be a second acknowledgement, which discord.js rejects.
 */
export function createInteractionRouter(plan: RegistryPlan, log: Logger): InteractionRouter {
  return async (interaction: Interaction): Promise<void> => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = plan.commands.get(interaction.commandName);
    if (command === undefined) {
      log.warn(
        { command: interaction.commandName },
        'chat-input command is not in the registry: deployed commands and loaded features disagree',
      );
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      log.error({ err: error, command: interaction.commandName }, 'command handler failed');
      await acknowledgeFailure(interaction);
    }
  };
}

/**
 * Attaches every planned listener to a client, including the command router.
 *
 * The router is bound here rather than at the call site so that "wiring a plan onto a client"
 * stays a single operation. A half-wired client — commands deployed but never routed — is the
 * exact failure this module exists to prevent, so it should not be expressible.
 *
 * A `log` is required for that reason: the router has no way to report a bad handler without one.
 */
export function applyRegistry(client: Client, plan: RegistryPlan, log: Logger): void {
  for (const binding of plan.bindings) {
    client.on(binding.event, binding.handler);
  }
  client.on('interactionCreate', createInteractionRouter(plan, log));
}

/* -------------------------------------------------------------------------------------------- */
/* Filesystem discovery                                                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * Extensions a loader will import. TypeScript sources are matched first when running through
 * `tsx` or a test runner; compiled `.js` files are matched when running from `dist/`.
 */
const MODULE_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Test files, declaration files and source maps are never runtime modules. */
const IGNORED_MODULE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]s$|\.d\.[cm]?ts$|\.map$/;

function isModuleFile(fileName: string): boolean {
  if (IGNORED_MODULE_PATTERN.test(fileName)) {
    return false;
  }
  return MODULE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function readDirectoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) {
      return [];
    }
    throw error;
  }
}

/**
 * Absolute path of the features directory that sits next to the compiled module.
 *
 * Resolved from `import.meta.url` rather than `process.cwd()` so it is correct under `tsx`
 * (`src/features`), the test runner (`src/features`) and a built process (`dist/features`).
 */
export function resolveFeaturesDir(metaUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', 'features');
}

/** Importable module files directly inside `directory`, sorted for deterministic order. */
export async function listModuleFiles(directory: string): Promise<string[]> {
  const entries = await readDirectoryEntries(directory);
  return entries
    .filter((entry) => entry.isFile() && isModuleFile(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** Importable module files anywhere under `directory`, sorted for deterministic order. */
export async function listModuleFilesRecursive(directory: string): Promise<string[]> {
  const entries = await readDirectoryEntries(directory);
  const files: string[] = [];
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listModuleFilesRecursive(fullPath)));
    } else if (entry.isFile() && isModuleFile(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Names of the feature folders under `featuresDir`. */
export async function listFeatureDirectories(featuresDir: string): Promise<string[]> {
  const entries = await readDirectoryEntries(featuresDir);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Path to each feature's `index` module, skipping folders that do not provide one. */
export async function findFeatureEntryPoints(
  featuresDir: string = resolveFeaturesDir(),
): Promise<string[]> {
  const entryPoints: string[] = [];
  for (const featureName of await listFeatureDirectories(featuresDir)) {
    const files = await listModuleFiles(path.join(featuresDir, featureName));
    const entry = files.find((file) => path.basename(file).startsWith('index.'));
    if (entry !== undefined) {
      entryPoints.push(entry);
    }
  }
  return entryPoints;
}

function pickDefaultExport(namespace: unknown): unknown {
  if (typeof namespace !== 'object' || namespace === null) {
    return namespace;
  }
  const candidate = (namespace as { default?: unknown }).default;
  return candidate ?? namespace;
}

/** Structural check for a `Feature`, used to reject a mistyped or empty feature module. */
export function isFeature(value: unknown): value is Feature {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

/** Imports one feature entry point and validates its shape. */
export async function loadFeature(entryPath: string): Promise<Feature> {
  const namespace: unknown = await import(pathToFileURL(entryPath).href);
  const candidate = pickDefaultExport(namespace);
  if (!isFeature(candidate)) {
    throw new TypeError(
      `${entryPath} must default-export a Feature object with a "name" property.`,
    );
  }
  return candidate;
}

/** Loads every feature under `featuresDir`, in directory-name order. */
export async function loadFeatures(featuresDir: string = resolveFeaturesDir()): Promise<Feature[]> {
  const features: Feature[] = [];
  for (const entryPoint of await findFeatureEntryPoints(featuresDir)) {
    features.push(await loadFeature(entryPoint));
  }
  return features;
}

/* -------------------------------------------------------------------------------------------- */
/* Command collection                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** A discovered command plus the file it came from, for actionable deployment errors. */
export interface LoadedSlashCommand {
  readonly source: string;
  readonly command: SlashCommandWithExecute;
}

/** Structural check for a slash command: an object carrying both `data` and `execute`. */
export function isSlashCommand(value: unknown): value is SlashCommandWithExecute {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { data?: unknown; execute?: unknown };
  return (
    typeof candidate.data === 'object' &&
    candidate.data !== null &&
    typeof candidate.execute === 'function'
  );
}

/**
 * Collects slash commands from every `<feature>/commands/` folder.
 *
 * Two authoring styles are accepted, because the discord.js guides use the split form while a
 * single object is easier to re-export from a barrel file:
 *   - split:    `export const data = ...; export async function execute(...) {}`
 *   - combined: `export const command = { data: ..., execute: ... }`
 */
export async function collectSlashCommands(
  featuresDir: string = resolveFeaturesDir(),
): Promise<LoadedSlashCommand[]> {
  const collected: LoadedSlashCommand[] = [];

  for (const featureName of await listFeatureDirectories(featuresDir)) {
    const files = await listModuleFilesRecursive(path.join(featuresDir, featureName, 'commands'));
    for (const file of files) {
      // A dynamic import is typed `any`; narrowing it to a record keeps the checks below honest.
      const namespace: Record<string, unknown> = await import(pathToFileURL(file).href);

      let matched = false;
      for (const value of Object.values(namespace)) {
        if (isSlashCommand(value)) {
          collected.push({ source: file, command: value });
          matched = true;
        }
      }
      if (matched) {
        continue;
      }

      const splitCandidate = { data: namespace['data'], execute: namespace['execute'] };
      if (isSlashCommand(splitCandidate)) {
        collected.push({ source: file, command: splitCandidate });
      }
    }
  }

  return collected;
}
