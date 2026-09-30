import { GatewayIntentBits } from 'discord.js';
import type { Client, Interaction } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  applyRegistry,
  collectSlashCommands,
  COMMAND_FAILURE_MESSAGE,
  createInteractionRouter,
  createRegistry,
  isFeature,
  isSlashCommand,
  listFeatureDirectories,
  listModuleFiles,
  listModuleFilesRecursive,
  loadFeatures,
  resolveFeaturesDir,
  type Feature,
  type SlashCommandWithExecute,
} from './registry.js';
import type { Logger } from './logger.js';

const NO_INTENTS: GatewayIntentBits[] = [];

function makeCommand(name: string): SlashCommandWithExecute {
  return {
    data: { name, description: `${name} command` },
    execute: () => undefined,
  };
}

function makeFeature(overrides: Partial<Feature> & { name: string }): Feature {
  return { ...overrides };
}

/** A `vi.fn()` spy, named without depending on which type alias the runner happens to export. */
type Spy = ReturnType<typeof vi.fn>;

/** A logger that records instead of printing. Only `warn` and `error` matter to the router. */
interface FakeLog {
  readonly log: Logger;
  readonly warn: Spy;
  readonly error: Spy;
}

function makeLog(): FakeLog {
  const warn = vi.fn();
  const error = vi.fn();
  return { log: { warn, error } as unknown as Logger, warn, error };
}

/** What a fake interaction should pretend to be, and whether it was already acknowledged. */
interface FakeInteractionSpec {
  readonly commandName: string;
  readonly chatInput?: boolean;
  readonly replied?: boolean;
  readonly deferred?: boolean;
}

interface FakeInteraction {
  readonly interaction: Interaction;
  readonly reply: Spy;
  readonly followUp: Spy;
}

/**
 * The smallest object the router can meaningfully read: the command name, the chat-input guard and
 * the acknowledgement flags, plus the two methods that answer the interaction.
 */
function makeInteraction(spec: FakeInteractionSpec): FakeInteraction {
  const reply = vi.fn().mockResolvedValue(undefined);
  const followUp = vi.fn().mockResolvedValue(undefined);
  const fake = {
    commandName: spec.commandName,
    replied: spec.replied ?? false,
    deferred: spec.deferred ?? false,
    isChatInputCommand: (): boolean => spec.chatInput ?? true,
    reply,
    followUp,
  };

  return { interaction: fake as unknown as Interaction, reply, followUp };
}

describe('createRegistry', () => {
  it('collects commands and their deployable payloads', () => {
    const plan = createRegistry(
      [makeFeature({ name: 'alpha', commands: [makeCommand('one'), makeCommand('two')] })],
      NO_INTENTS,
    );

    expect([...plan.commands.keys()]).toEqual(['one', 'two']);
    expect(plan.commandData.map((command) => command.name)).toEqual(['one', 'two']);
    expect(plan.features).toEqual(['alpha']);
  });

  it('keeps the first registration and reports the duplicate', () => {
    const first = makeCommand('shared');
    const second = makeCommand('shared');
    const plan = createRegistry(
      [
        makeFeature({ name: 'alpha', commands: [first] }),
        makeFeature({ name: 'beta', commands: [second] }),
      ],
      NO_INTENTS,
    );

    expect(plan.commands.get('shared')).toBe(first);
    expect(plan.duplicateCommands).toEqual([{ name: 'shared', features: ['alpha', 'beta'] }]);
  });

  it('turns each declared handler into a tagged binding', () => {
    const handler = (): undefined => undefined;
    const plan = createRegistry(
      [makeFeature({ name: 'alpha', handlers: { guildMemberAdd: handler, guildCreate: handler } })],
      NO_INTENTS,
    );

    expect(plan.bindings).toEqual([
      { event: 'guildMemberAdd', feature: 'alpha', handler },
      { event: 'guildCreate', feature: 'alpha', handler },
    ]);
  });

  it('keeps listeners for the same event from different features', () => {
    const alpha = (): undefined => undefined;
    const beta = (): undefined => undefined;
    const plan = createRegistry(
      [
        makeFeature({ name: 'alpha', handlers: { messageCreate: alpha } }),
        makeFeature({ name: 'beta', handlers: { messageCreate: beta } }),
      ],
      NO_INTENTS,
    );

    expect(plan.bindings.map((binding) => binding.handler)).toEqual([alpha, beta]);
  });

  it('rejects a non-function handler instead of failing later at bind time', () => {
    const feature = { name: 'alpha', handlers: { guildCreate: 'nope' } } as unknown as Feature;
    expect(() => createRegistry([feature], NO_INTENTS)).toThrow(/non-function handler/);
  });

  it('reports declared intents that are not enabled', () => {
    const plan = createRegistry(
      [
        makeFeature({
          name: 'welcome',
          requiredIntents: [GatewayIntentBits.GuildMembers, GatewayIntentBits.Guilds],
        }),
      ],
      [GatewayIntentBits.Guilds],
    );

    expect(plan.missingIntents).toEqual([
      { feature: 'welcome', intents: [GatewayIntentBits.GuildMembers] },
    ]);
  });

  it('reports nothing missing when every declared intent is active', () => {
    const plan = createRegistry(
      [makeFeature({ name: 'welcome', requiredIntents: [GatewayIntentBits.GuildMembers] })],
      [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    );

    expect(plan.missingIntents).toEqual([]);
  });

  it('accepts a feature with no commands and no handlers', () => {
    const plan = createRegistry([makeFeature({ name: 'empty' })], NO_INTENTS);
    expect(plan.commands.size).toBe(0);
    expect(plan.bindings).toEqual([]);
    expect(plan.duplicateCommands).toEqual([]);
    expect(plan.missingIntents).toEqual([]);
  });
});

describe('createInteractionRouter', () => {
  it('routes a chat-input interaction to its handler exactly once', async () => {
    const execute = vi.fn();
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );
    const { log } = makeLog();
    const { interaction } = makeInteraction({ commandName: 'ping' });

    await createInteractionRouter(plan, log)(interaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(interaction);
  });

  it('ignores an interaction that is not a chat-input command', async () => {
    const execute = vi.fn();
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );
    const { log, warn } = makeLog();
    const { interaction, reply, followUp } = makeInteraction({ commandName: 'ping', chatInput: false });

    await createInteractionRouter(plan, log)(interaction);

    expect(execute).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and stops when the command name is not in the plan', async () => {
    const plan = createRegistry([makeFeature({ name: 'ping', commands: [makeCommand('ping')] })], NO_INTENTS);
    const { log, warn, error } = makeLog();
    const { interaction, reply } = makeInteraction({ commandName: 'ghost' });

    // A rejection here would fail the test, which is the assertion: a miss must not crash the bot.
    await createInteractionRouter(plan, log)(interaction);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ command: 'ghost' });
    expect(error).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('replies ephemerally when a handler throws before acknowledging', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('boom'));
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );
    const { log, error } = makeLog();
    const { interaction, reply, followUp } = makeInteraction({ commandName: 'ping' });

    await createInteractionRouter(plan, log)(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      content: COMMAND_FAILURE_MESSAGE,
      ephemeral: true,
    });
    expect(followUp).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toMatchObject({ command: 'ping' });
  });

  it('follows up instead of replying when the handler already acknowledged', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('boom'));
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );

    for (const acknowledged of [{ replied: true }, { deferred: true }]) {
      const { log } = makeLog();
      const { interaction, reply, followUp } = makeInteraction({ commandName: 'ping', ...acknowledged });

      await createInteractionRouter(plan, log)(interaction);

      expect(followUp).toHaveBeenCalledTimes(1);
      expect(followUp).toHaveBeenCalledWith({
        content: COMMAND_FAILURE_MESSAGE,
        ephemeral: true,
      });
      // A second acknowledgement is exactly what discord.js rejects.
      expect(reply).not.toHaveBeenCalled();
    }
  });

  it('never leaks internal error detail to the user', async () => {
    const execute = vi.fn().mockRejectedValue(
      new Error('ENOENT: no such file or directory, open "C:\\secrets\\.env"'),
    );
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );
    const { log } = makeLog();
    const { interaction, reply } = makeInteraction({ commandName: 'ping' });

    await createInteractionRouter(plan, log)(interaction);

    const payload = reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toBe(COMMAND_FAILURE_MESSAGE);
    expect(payload.content).not.toMatch(/ENOENT|\.env|\\|Error:/);
  });

  it('leaves acknowledgement to the handler on the success path', async () => {
    // A realistic handler: it is the one that replies.
    const execute = vi.fn().mockImplementation(async (interaction: Interaction) => {
      await (interaction as unknown as { reply: (payload: unknown) => Promise<void> }).reply({ content: 'Pong!' });
    });
    const plan = createRegistry(
      [makeFeature({ name: 'ping', commands: [{ data: { name: 'ping', description: 'p' }, execute }] })],
      NO_INTENTS,
    );
    const { log, error } = makeLog();
    const { interaction, reply, followUp } = makeInteraction({ commandName: 'ping' });

    await createInteractionRouter(plan, log)(interaction);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({ content: 'Pong!' });
    expect(followUp).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('applyRegistry', () => {
  it('binds an interactionCreate listener so deployed commands are actually routed', () => {
    const plan = createRegistry([makeFeature({ name: 'ping', commands: [makeCommand('ping')] })], NO_INTENTS);
    const { log } = makeLog();
    const on = vi.fn();

    applyRegistry({ on } as unknown as Client, plan, log);

    // This is the regression guard for the reported bug: commands were deployed through
    // `plan.commands`, but nothing ever connected that map to the gateway.
    const events = on.mock.calls.map((call) => call[0]);
    expect(events).toContain('interactionCreate');
  });

  it('still binds the listeners features declared', () => {
    const handler = (): undefined => undefined;
    const plan = createRegistry([makeFeature({ name: 'welcome', handlers: { guildMemberAdd: handler } })], NO_INTENTS);
    const { log } = makeLog();
    const on = vi.fn();

    applyRegistry({ on } as unknown as Client, plan, log);

    expect(on.mock.calls.map((call) => call[0])).toEqual(['guildMemberAdd', 'interactionCreate']);
  });
});

describe('type guards', () => {
  it('recognises a slash command only when both data and execute are present', () => {
    expect(isSlashCommand({ data: { name: 'x' }, execute: () => undefined })).toBe(true);
    expect(isSlashCommand({ data: { name: 'x' } })).toBe(false);
    expect(isSlashCommand({ execute: () => undefined })).toBe(false);
    expect(isSlashCommand({ data: null, execute: () => undefined })).toBe(false);
    expect(isSlashCommand(null)).toBe(false);
    expect(isSlashCommand('ping')).toBe(false);
  });

  it('recognises a feature by its name property', () => {
    expect(isFeature({ name: 'ping' })).toBe(true);
    expect(isFeature({ commands: [] })).toBe(false);
    expect(isFeature(undefined)).toBe(false);
  });
});

describe('filesystem discovery', () => {
  const featuresDir = resolveFeaturesDir();

  it('resolves the features directory next to the compiled module', () => {
    expect(featuresDir.endsWith('features')).toBe(true);
  });

  it('finds the shipped feature folders', async () => {
    expect(await listFeatureDirectories(featuresDir)).toEqual(['ping', 'welcome']);
  });

  it('returns an empty list for a directory that does not exist', async () => {
    expect(await listModuleFiles(`${featuresDir}\\does-not-exist`)).toEqual([]);
    expect(await listModuleFilesRecursive(`${featuresDir}\\does-not-exist`)).toEqual([]);
  });

  it('walks nested folders recursively', async () => {
    const files = await listModuleFilesRecursive(`${featuresDir}\\welcome`);
    const relative = files.map((file) =>
      file.slice(`${featuresDir}\\welcome\\`.length).split('\\').join('/'),
    );
    expect(relative).toEqual([
      'commands/config-greeting.ts',
      'greeting-store.ts',
      'handlers/greeting.ts',
      'index.ts',
    ]);
  });
});

describe('the shipped feature tree', () => {
  const featuresDir = resolveFeaturesDir();

  it('loads both features', async () => {
    const features = await loadFeatures(featuresDir);
    expect(features.map((feature) => feature.name)).toEqual(['ping', 'welcome']);
  });

  it('discovers every command declared in a feature manifest', async () => {
    const features = await loadFeatures(featuresDir);
    const plan = createRegistry(features, NO_INTENTS);
    const discovered = await collectSlashCommands(featuresDir);

    expect([...plan.commands.keys()].sort()).toEqual(['config-greeting', 'ping']);
    expect(discovered.map((entry) => entry.command.data.name).sort()).toEqual([
      'config-greeting',
      'ping',
    ]);
  });

  it('plans the guildMemberAdd binding for the welcome feature', async () => {
    const features = await loadFeatures(featuresDir);
    const plan = createRegistry(features, NO_INTENTS);

    expect(plan.bindings).toEqual([
      expect.objectContaining({ event: 'guildMemberAdd', feature: 'welcome' }),
    ]);
  });

  it('flags the privileged intent as missing when it is not enabled', async () => {
    const features = await loadFeatures(featuresDir);
    const withPrivileged = createRegistry(features, [GatewayIntentBits.GuildMembers]);

    expect(createRegistry(features, NO_INTENTS).missingIntents).toEqual([
      { feature: 'welcome', intents: [GatewayIntentBits.GuildMembers] },
    ]);
    expect(withPrivileged.missingIntents).toEqual([]);
  });
});
