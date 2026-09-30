import { GatewayIntentBits } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  collectSlashCommands,
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
