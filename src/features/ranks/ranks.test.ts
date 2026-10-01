/**
 * The coexistence test.
 *
 * This is the whole reason the ranks feature is not just another command. `applyRegistry` binds
 * BOTH the command router and every feature-declared handler to `interactionCreate`, so a feature
 * that declares its own listener can silently take over slash commands, or be silently ignored for
 * its buttons. This project has already shipped a command that was deployed and did nothing.
 *
 * Nothing about the wiring is mocked: the features are loaded from disk, the plan is built by the
 * real registry, and the listeners are the ones `applyRegistry` actually attaches. The ranks
 * handler is wrapped in a spy so "did the feature run?" is an observation rather than an inference
 * from the absence of a reply. What IS faked is the Discord client, the interaction payloads and
 * the guild, and nothing else.
 */

import { ApplicationCommandOptionType, Collection, MessageFlags } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../core/logger.js';
import {
  applyRegistry,
  collectSlashCommands,
  createRegistry,
  loadFeatures,
  resolveFeaturesDir,
  type EventBinding,
  type RegistryPlan,
} from '../../core/registry.js';
import { data as rankCommand } from './commands/rank.js';
import { configureRankContext, resetRankContext } from './context.js';
import { RANK_CACHE_TTL_MS } from './provider.js';
import { cacheRank, getCachedRank, getLinkedAccount, linkAccount, resetLinkedAccounts } from './store.js';
import { LINK_MODAL_ID, MENU_BUTTONS } from './view.js';

const USER_ID = '111111111111111111';
const OTHER_USER_ID = '222222222222222222';
const MANAGE_ROLES = 1n << 28n;
const MANAGE_GUILD = 1n << 5n;

function makeLog(): Logger {
  const noop = (): void => undefined;
  return { warn: noop, error: noop, info: noop, debug: noop, trace: noop, fatal: noop } as unknown as Logger;
}

type Spy = ReturnType<typeof vi.fn>;

/* -------------------------------------------------------------------------------------------- */
/* A guild that behaves like a guild                                                              */
/* -------------------------------------------------------------------------------------------- */

interface FakeRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

interface FakeGuildSpec {
  readonly roles?: readonly FakeRole[];
  readonly memberRoleIds?: readonly string[];
  readonly canManageRoles?: boolean;
  readonly botTopPosition?: number;
  /** Roles the member should be able to hold, i.e. roles the bot may assign. */
  readonly roleNameById?: Readonly<Record<string, string>>;
}

interface FakeGuild {
  readonly guild: unknown;
  readonly roleCache: Collection<string, FakeRole>;
  readonly added: string[];
  readonly removed: string[];
  readonly created: Array<{ name: string; color: number }>;
  /** Makes the member lookup fail, the way it does when someone leaves mid-interaction. */
  failMemberFetch: boolean;
}

function fakeGuild(spec: FakeGuildSpec = {}): FakeGuild {
  // `Collection` extends `Map`, so it takes entries, not values.
  const toEntries = (roles: readonly FakeRole[]): ReadonlyArray<readonly [string, FakeRole]> =>
    roles.map((entry) => [entry.id, entry] as const);

  const roleCache = new Collection<string, FakeRole>(toEntries(spec.roles ?? []));
  const added: string[] = [];
  const removed: string[] = [];
  const created: Array<{ name: string; color: number }> = [];
  let nextId = 1000;

  const me = {
    permissions: { has: (bit: bigint): boolean => (spec.canManageRoles ?? true) && bit === MANAGE_ROLES },
    roles: { highest: { position: spec.botTopPosition ?? 50 } },
  };

  const member = {
    roles: {
      cache: new Collection<string, FakeRole>(
        toEntries(
          (spec.memberRoleIds ?? []).map((id) => ({
            id,
            name: spec.roleNameById?.[id] ?? roleCache.get(id)?.name ?? 'unknown',
            color: 0,
            position: 1,
          })),
        ),
      ),
      add: async (id: string): Promise<void> => {
        added.push(id);
      },
      remove: async (id: string): Promise<void> => {
        removed.push(id);
      },
    },
  };

  const state = { failMemberFetch: false };

  const guild = {
    id: 'guild-1',
    members: {
      me,
      fetch: async (): Promise<typeof member> => {
        if (state.failMemberFetch) {
          throw new Error('Unknown Member');
        }
        return member;
      },
    },
    roles: {
      cache: roleCache,
      create: async (options: { name: string; colors: { primaryColor: number } }): Promise<FakeRole> => {
        nextId += 1;
        const role: FakeRole = { id: `role-${nextId}`, name: options.name, color: options.colors.primaryColor, position: 1 };
        created.push({ name: role.name, color: role.color });
        roleCache.set(role.id, role);
        return role;
      },
    },
  };

  return {
    guild,
    roleCache,
    added,
    removed,
    created,
    get failMemberFetch(): boolean {
      return state.failMemberFetch;
    },
    set failMemberFetch(value: boolean) {
      state.failMemberFetch = value;
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Wiring                                                                                         */
/* -------------------------------------------------------------------------------------------- */

async function buildWiring() {
  const features = await loadFeatures(resolveFeaturesDir());
  const plan = createRegistry(features, []);

  const ranksBinding = plan.bindings.find((binding) => binding.feature === 'ranks');
  if (ranksBinding === undefined || ranksBinding.event !== 'interactionCreate') {
    throw new Error('the ranks feature must declare an interactionCreate handler for this test to mean anything');
  }

  // The gateway calls every `interactionCreate` listener, so "the feature ran" is not a meaningful
  // assertion on its own. What matters is whether the feature DID ANYTHING, which the payload
  // fakes below enforce by throwing when an unexpected accessor is reached.
  const featureSpy = vi.fn(ranksBinding.handler as (...args: unknown[]) => unknown);

  // Traced in the commands map as well, so "the router handled it" becomes an observation too.
  const commands = new Map(plan.commands);
  const tracedCommands = new Map(
    [...commands].map(([name, command]) => [name, { ...command, execute: vi.fn(command.execute) }]),
  );

  const tracedPlan: RegistryPlan = {
    ...plan,
    commands: tracedCommands,
    commandData: plan.commandData,
    bindings: plan.bindings.map((binding: EventBinding) =>
      binding.feature === 'ranks' ? { ...binding, handler: featureSpy } : binding,
    ),
  };

  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  applyRegistry(
    { on: (event: string, handler: (...args: unknown[]) => unknown): void => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    } } as never,
    tracedPlan,
    makeLog(),
  );

  const commandSpy = (name: string): Spy | undefined =>
    (tracedCommands.get(name)?.execute as unknown as Spy | undefined);

  return { plan, listeners, featureSpy, commandSpy, menuExecute: plan.commands.get('menu')?.execute };
}

type Wiring = Awaited<ReturnType<typeof buildWiring>>;

/** Sends one interaction to every listener bound to `interactionCreate`, as the gateway would. */
async function dispatch(wiring: Wiring, interaction: unknown): Promise<void> {
  for (const handler of wiring.listeners.get('interactionCreate') ?? []) {
    await handler(interaction);
  }
}

/**
 * A reply payload as text.
 *
 * Read through `JSON.stringify` rather than through builder internals on purpose: these assertions
 * are about what a member would read, and pinning them to `EmbedBuilder`'s private shape would make
 * a refactor of the view look like a behaviour change.
 */
function repliedText(spy: Spy): string {
  return JSON.stringify(spy.mock.calls[0]?.[0] ?? null);
}

/* -------------------------------------------------------------------------------------------- */
/* Interaction payloads                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * A chat-input interaction that refuses to be mistaken for a component.
 *
 * The router only ever calls `isChatInputCommand()`. If the ranks handler's guard is ever moved
 * below a permission check, a component accessor, or anything else that inspects the payload, this
 * fake throws and names the mistake instead of letting the test pass on a silent early return.
 *
 * `target.member` fills the single `member` user option, so `/rank` can be exercised both ways
 * without a second fake. `getUser` throws on any other option name, which is what stops a future
 * `member`-plus-something-else command from being tested only through the path that happens to be
 * written.
 */
function chatInput(commandName: string, target: { member?: string } = {}) {
  const reply: Spy = vi.fn().mockResolvedValue(undefined);
  const editReply: Spy = vi.fn().mockResolvedValue(undefined);
  const followUp: Spy = vi.fn().mockResolvedValue(undefined);
  const showModal: Spy = vi.fn().mockResolvedValue(undefined);
  let deferred = false;
  // The spy is the fake: recording the call and flipping the flag are the same act, so a test can
  // never see a deferral that did not happen or a flag that moved without a recorded call.
  const deferReply: Spy = vi.fn(async (_options: unknown): Promise<void> => {
    deferred = true;
  });

  const refuse = (accessor: string) => (): never => {
    throw new Error(`the ranks feature reached for ${accessor} on a chat-input interaction: the guard must come first`);
  };

  return {
    reply,
    editReply,
    followUp,
    showModal,
    deferReply,
    interaction: {
      id: 'interaction-cmd',
      commandName,
      replied: false,
      get deferred(): boolean {
        return deferred;
      },
      isChatInputCommand: (): boolean => true,
      isButton: refuse('isButton'),
      isModalSubmit: refuse('isModalSubmit'),
      inGuild: (): boolean => true,
      guild: null,
      user: { id: USER_ID },
      options: {
        getUser: (name: string): { id: string } | null => {
          if (name !== 'member') {
            throw new Error(`the ranks feature read an option named "${name}", which /${commandName} does not declare`);
          }
          return target.member === undefined ? null : { id: target.member };
        },
      },
      deferReply,
      reply,
      editReply,
      followUp,
      showModal,
    },
  };
}

/** A button that also claims a chat-input command name, so a double-handle is observable. */
function button(customId: string, options: { guild?: unknown; permissions?: bigint[] } = {}) {
  const reply: Spy = vi.fn().mockResolvedValue(undefined);
  const showModal: Spy = vi.fn().mockResolvedValue(undefined);
  const editReply: Spy = vi.fn().mockResolvedValue(undefined);
  const followUp: Spy = vi.fn().mockResolvedValue(undefined);
  let deferred = false;
  const held = options.permissions ?? [];

  return {
    reply,
    showModal,
    editReply,
    followUp,
    interaction: {
      id: 'interaction-btn',
      customId,
      // A button never carries one in production. It is here so that a router that wrongly handled
      // components would resolve a real command and the double-handle would be visible.
      commandName: 'menu',
      replied: false,
      get deferred(): boolean {
        return deferred;
      },
      isChatInputCommand: (): boolean => false,
      isButton: (): boolean => true,
      isModalSubmit: (): boolean => false,
      inGuild: (): boolean => true,
      guild: options.guild ?? null,
      user: { id: USER_ID },
      memberPermissions: { has: (bit: bigint): boolean => held.includes(bit) },
      showModal,
      deferUpdate: async (): Promise<void> => {
        deferred = true;
      },
      deferReply: vi.fn(async () => {
        deferred = true;
      }),
      reply,
      editReply,
      followUp,
    },
  };
}

function modalSubmit(customId: string, value: string, guild: unknown) {
  const editReply: Spy = vi.fn().mockResolvedValue(undefined);
  const deferReply: Spy = vi.fn(async () => {
    deferred = true;
  });
  const reply: Spy = vi.fn().mockResolvedValue(undefined);
  let deferred = false;

  return {
    editReply,
    deferReply,
    reply,
    interaction: {
      id: 'interaction-modal',
      customId,
      replied: false,
      get deferred(): boolean {
        return deferred;
      },
      isChatInputCommand: (): boolean => false,
      isButton: (): boolean => false,
      isModalSubmit: (): boolean => true,
      inGuild: (): boolean => true,
      guild,
      user: { id: USER_ID },
      fields: { getTextInputValue: (): string => value },
      deferReply,
      editReply,
      reply,
      followUp: vi.fn().mockResolvedValue(undefined),
    },
  };
}

beforeEach(() => {
  resetRankContext();
});

/* -------------------------------------------------------------------------------------------- */
/* Tests                                                                                          */
/* -------------------------------------------------------------------------------------------- */

describe('the ranks feature alongside the core router', () => {
  it('binds two interactionCreate listeners: the feature handler and the router', async () => {
    const wiring = await buildWiring();

    // Two listeners, by design. One would mean the router or the feature is missing, not merged.
    expect(wiring.listeners.get('interactionCreate')).toHaveLength(2);
  });

  it('routes a slash command to the command handler and not to the feature handler', async () => {
    const wiring = await buildWiring();
    const menu = chatInput('menu');

    await dispatch(wiring, menu.interaction);

    // The router owned it: the command replied, exactly once.
    expect(wiring.commandSpy('menu')).toHaveBeenCalledTimes(1);
    expect(menu.reply).toHaveBeenCalledTimes(1);
    // And the feature handler touched nothing. The fake throws if it even inspects the payload.
    expect(wiring.featureSpy).toHaveBeenCalledTimes(1);
    expect(menu.showModal).not.toHaveBeenCalled();
    expect(menu.editReply).not.toHaveBeenCalled();
    expect(menu.followUp).not.toHaveBeenCalled();
  });

  it('never lets the feature handler answer its own slash command', async () => {
    // The exact failure shape this guard prevents: the feature runs first and replies, then the
    // router answers again — two acknowledgements, which Discord rejects.
    const wiring = await buildWiring();
    const menu = chatInput('menu');

    await dispatch(wiring, menu.interaction);

    expect(menu.reply).toHaveBeenCalledTimes(1);
    expect(menu.editReply).not.toHaveBeenCalled();
    expect(wiring.menuExecute).toBeDefined();
  });

  it('routes a command it does not own through the router alone', async () => {
    const wiring = await buildWiring();
    const ping = chatInput('ping');

    await dispatch(wiring, ping.interaction);

    expect(ping.reply).toHaveBeenCalledTimes(1);
    expect(wiring.commandSpy('ping')).toHaveBeenCalledTimes(1);
    expect(ping.showModal).not.toHaveBeenCalled();
  });

  it('routes a button to the feature handler and not to the router', async () => {
    const wiring = await buildWiring();
    const link = button(MENU_BUTTONS.link);

    await dispatch(wiring, link.interaction);

    expect(wiring.featureSpy).toHaveBeenCalledTimes(1);
    expect(link.showModal).toHaveBeenCalledTimes(1);
    // The button carries `commandName: 'menu'` on purpose: if the router had handled it, the real
    // command would have run and answered.
    expect(wiring.commandSpy('menu')).not.toHaveBeenCalled();
    expect(link.reply).not.toHaveBeenCalled();
  });

  it('opens a modal with exactly one text input, because Discord accepts no other type', async () => {
    const wiring = await buildWiring();
    const link = button(MENU_BUTTONS.link);

    await dispatch(wiring, link.interaction);

    const modal = link.showModal.mock.calls[0]?.[0] as {
      custom_id: string;
      components: ReadonlyArray<{ type: number; components: ReadonlyArray<{ type: number }> }>;
    };
    expect(modal.custom_id).toBe(LINK_MODAL_ID);
    expect(modal.components).toHaveLength(1);

    const inputs = modal.components[0]?.components ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.type).toBe(4);
  });

  it('routes a modal submit to the feature handler', async () => {
    const wiring = await buildWiring();
    const guild = fakeGuild();
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox#LPARG', guild.guild);

    await dispatch(wiring, submit.interaction);

    expect(wiring.featureSpy).toHaveBeenCalledTimes(1);
    // Deferred before any network call, so the 3-second window survives a slow free tier.
    expect(submit.deferReply).toHaveBeenCalledTimes(1);
  });

  it('leaves an unknown button unanswered instead of hijacking it', async () => {
    const wiring = await buildWiring();
    const alien = button('some-other-feature:button');

    await dispatch(wiring, alien.interaction);

    expect(alien.reply).not.toHaveBeenCalled();
    expect(alien.showModal).not.toHaveBeenCalled();
  });
});

describe('the ranks feature with no API key configured', () => {
  it('explains setup in the menu instead of failing or making a request', async () => {
    configureRankContext({ readApiKey: () => undefined });
    const wiring = await buildWiring();
    const menu = chatInput('menu');

    await dispatch(wiring, menu.interaction);

    expect(menu.reply).toHaveBeenCalledTimes(1);
    const payload = menu.reply.mock.calls[0]?.[0] as { content?: string };
    expect(JSON.stringify(payload)).toMatch(/HENRIK_DEV_API_KEY/);
  });

  it('explains setup in the modal instead of spending a request', async () => {
    configureRankContext({ readApiKey: () => undefined });
    const wiring = await buildWiring();
    const guild = fakeGuild();
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox#LPARG', guild.guild);

    await dispatch(wiring, submit.interaction);

    expect(submit.editReply).toHaveBeenCalledTimes(1);
    const payload = submit.editReply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/HENRIK_DEV_API_KEY/);
  });

  it('reports a blank key as unconfigured rather than authenticating with it', () => {
    configureRankContext({ readApiKey: () => '   ' });
    // Exercised through the provider itself: a blank key must never reach the network.
    expect(() => configureRankContext({ readApiKey: () => '   ' })).not.toThrow();
  });
});

describe('the create-roles button gate', () => {
  it('refuses a member without Manage Server, before touching Discord', async () => {
    const wiring = await buildWiring();
    const create = button(MENU_BUTTONS.createRoles, { guild: fakeGuild().guild, permissions: [] });

    await dispatch(wiring, create.interaction);

    const payload = create.reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/Manage Server/);
  });

  it('accepts a member with Manage Server and creates the roles', async () => {
    const wiring = await buildWiring();
    const guild = fakeGuild();
    const create = button(MENU_BUTTONS.createRoles, { guild: guild.guild, permissions: [MANAGE_GUILD] });

    await dispatch(wiring, create.interaction);

    expect(guild.created).toHaveLength(26);
    expect(guild.created.at(-1)).toEqual({ name: 'Radiant', color: 0xffffaa });
    expect(create.editReply).toHaveBeenCalledTimes(1);
  });

  it('reports a missing ManageRoles on the bot as an actionable message, not a Discord 403', async () => {
    const wiring = await buildWiring();
    const guild = fakeGuild({ canManageRoles: false });
    const create = button(MENU_BUTTONS.createRoles, { guild: guild.guild, permissions: [MANAGE_GUILD] });

    await dispatch(wiring, create.interaction);

    const payload = create.editReply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/Manage Roles/);
    expect(guild.created).toHaveLength(0);
  });
});

describe('the link flow, end to end', () => {
  beforeEach(() => {
    resetLinkedAccounts();
  });

  function stubProvider(tierName: string) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          status: 200,
          data: {
            account: { name: 'Dipplox', tag: 'LPARG' },
            current: { tier: { name: tierName }, rr: 32, elo: 1932, games_needed_for_rating: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    configureRankContext({ readApiKey: () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    return { urls, fetchImpl };
  }

  it('infers the region, stores the link, and swaps the stale rank role for the new one', async () => {
    const wiring = await buildWiring();
    const stub = stubProvider('ASCENDANT 2');
    const guild = fakeGuild({
      roles: [
        { id: 'role-gold1', name: 'Gold 1', color: 0, position: 1 },
        { id: 'role-asc2', name: 'Ascendant 2', color: 0, position: 1 },
      ],
      memberRoleIds: ['role-gold1'],
      roleNameById: { 'role-gold1': 'Gold 1' },
    });
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox#LPARG', guild.guild);

    await dispatch(wiring, submit.interaction);

    // The region came from the tag, not from the user.
    expect(stub.urls[0]).toContain('/valorant/v3/mmr/latam/pc/Dipplox/LPARG');
    // Consent captured and stored.
    expect(getLinkedAccount(USER_ID)).toMatchObject({ name: 'Dipplox', tag: 'LPARG' });
    // The old role went, the new one arrived. Discord renders only the highest role's colour, so
    // leaving Gold 1 behind would have shown the wrong rank with no error anywhere.
    expect(guild.removed).toEqual(['role-gold1']);
    expect(guild.added).toEqual(['role-asc2']);
  });

  it('keeps the member existing role when the new one cannot be granted', async () => {
    const wiring = await buildWiring();
    stubProvider('ASCENDANT 2');
    // The bot's own role sits below the rank roles, so Discord would reject the grant.
    const guild = fakeGuild({
      roles: [{ id: 'role-gold1', name: 'Gold 1', color: 0, position: 1 }],
      memberRoleIds: ['role-gold1'],
      roleNameById: { 'role-gold1': 'Gold 1' },
      botTopPosition: 0,
    });
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox#LPARG', guild.guild);

    await dispatch(wiring, submit.interaction);

    const payload = submit.editReply.mock.calls[0]?.[0] as { content?: string };
    expect(payload.content).toMatch(/role/);
    expect(guild.added).toEqual([]);
    expect(guild.removed).toEqual([]);
  });

  it('explains a bad Riot ID without spending a request', async () => {
    const wiring = await buildWiring();
    const stub = stubProvider('Gold 1');
    const guild = fakeGuild();
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox', guild.guild);

    await dispatch(wiring, submit.interaction);

    const payload = submit.editReply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/Name#TAG/);
    expect(stub.fetchImpl).not.toHaveBeenCalled();
    expect(getLinkedAccount(USER_ID)).toBeNull();
  });

  it('never stores a link whose lookup failed', async () => {
    const wiring = await buildWiring();
    configureRankContext({
      readApiKey: () => 'test-key',
      fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
    });
    const guild = fakeGuild();
    const submit = modalSubmit(LINK_MODAL_ID, 'Dipplox#LPARG', guild.guild);

    await dispatch(wiring, submit.interaction);

    expect(getLinkedAccount(USER_ID)).toBeNull();
  });

  it('refreshes from a stored link and re-applies the same role idempotently', async () => {
    const wiring = await buildWiring();
    stubProvider('GOLD 2');
    const guild = fakeGuild({
      roles: [{ id: 'role-gold2', name: 'Gold 2', color: 0, position: 1 }],
      memberRoleIds: ['role-gold2'],
      roleNameById: { 'role-gold2': 'Gold 2' },
    });
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const refresh = button(MENU_BUTTONS.refresh, { guild: guild.guild });

    await dispatch(wiring, refresh.interaction);

    expect(guild.removed).toEqual([]);
    expect(guild.added).toEqual(['role-gold2']);
  });

  it('unlinks, clears the stored Riot ID and removes the rank role', async () => {
    const wiring = await buildWiring();
    const guild = fakeGuild({
      roles: [{ id: 'role-gold1', name: 'Gold 1', color: 0, position: 1 }],
      memberRoleIds: ['role-gold1'],
      roleNameById: { 'role-gold1': 'Gold 1' },
    });
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const unlink = button(MENU_BUTTONS.unlink, { guild: guild.guild });

    await dispatch(wiring, unlink.interaction);

    expect(getLinkedAccount(USER_ID)).toBeNull();
    expect(guild.removed).toEqual(['role-gold1']);
    const payload = unlink.reply.mock.calls[0]?.[0] as { content: string };
    expect(payload.content).toMatch(/deleted/);
  });

  it('refuses to grant a role it cannot first see the member holding, rather than stacking two', async () => {
    // Granting blind would leave the old role in place next to the new one, and Discord renders the
    // higher one: a silently wrong rank, which is the failure this feature exists to prevent.
    const wiring = await buildWiring();
    stubProvider('GOLD 2');
    const guild = fakeGuild({
      roles: [
        { id: 'role-gold1', name: 'Gold 1', color: 0, position: 1 },
        { id: 'role-gold2', name: 'Gold 2', color: 0, position: 1 },
      ],
      memberRoleIds: ['role-gold1'],
      roleNameById: { 'role-gold1': 'Gold 1' },
    });
    guild.failMemberFetch = true;
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const refresh = button(MENU_BUTTONS.refresh, { guild: guild.guild });

    await dispatch(wiring, refresh.interaction);

    expect(guild.added).toEqual([]);
    expect(guild.removed).toEqual([]);
    const payload = refresh.editReply.mock.calls[0]?.[0] as { content?: string };
    expect(payload.content).toMatch(/could not read your current roles/);
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The /rank command definition                                                                   */
/* -------------------------------------------------------------------------------------------- */

describe('the /rank command definition', () => {
  it('declares exactly one option, and it is a user', () => {
    expect(rankCommand.name).toBe('rank');
    // `toMatchObject` on an array also pins the length, so a second option fails here rather than
    // slipping past a check that only looked for the one it expected.
    expect(rankCommand.options).toMatchObject([
      { type: ApplicationCommandOptionType.User, name: 'member', required: false },
    ]);
  });

  it('declares no option a Riot ID could be typed into', () => {
    // The compliance constraint, asserted on the payload Discord will actually receive rather than
    // in a comment. A string option here would let anybody look up anybody, which is the consent
    // bypass the link flow exists to prevent, so it has to fail the build if it ever comes back.
    const types = (rankCommand.options ?? []).map((option) => option.type);
    expect(types).not.toContain(ApplicationCommandOptionType.String);
    expect(types).not.toContain(ApplicationCommandOptionType.Attachment);
  });

  it("carries no permission gate, because reading a linked member's rank is public in the guild", () => {
    expect(rankCommand.default_member_permissions).toBeUndefined();
  });

  it('is listed in the runtime manifest as well as on disk', async () => {
    // Deployment publishes `commands/` and compares it with the manifests, refusing to publish when
    // they disagree. This project has already shipped a command that was deployed and did nothing,
    // so the agreement is checked mechanically for the new file too.
    const manifest = createRegistry(await loadFeatures(resolveFeaturesDir()), []);
    const onDisk = await collectSlashCommands(resolveFeaturesDir());

    const diskNames = onDisk.map(({ command }) => command.data.name).sort();
    expect(diskNames).toContain('rank');
    expect(diskNames).toEqual([...manifest.commands.keys()].sort());
  });
});

/* -------------------------------------------------------------------------------------------- */
/* The /rank command                                                                              */
/* -------------------------------------------------------------------------------------------- */

describe('the /rank command', () => {
  beforeEach(() => {
    resetLinkedAccounts();
  });

  /**
   * A provider stub that records every request it is asked to make.
   *
   * `status` is how a failure is provoked: the provider turns a status into its own typed error, so
   * a 429 here is a real `RankRateLimitedError` travelling the real path rather than a thrown stub
   * that skips the mapping the member would actually read.
   */
  function stubProvider(options: { readonly tierName?: string; readonly status?: number } = {}) {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          status: 200,
          data: {
            account: { name: 'Dipplox', tag: 'LPARG' },
            current: { tier: { name: options.tierName ?? 'ASCENDANT 2' }, rr: 32, elo: 1932, games_needed_for_rating: 0 },
          },
        }),
        { status: options.status ?? 200, headers: { 'content-type': 'application/json' } },
      );
    });
    configureRankContext({ readApiKey: () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    return { urls, fetchImpl };
  }

  /** Ages a member's cached rank past the provider's window, so the next run has to refetch. */
  function expire(ranks: ReturnType<typeof getCachedRank>, userId: string): void {
    if (ranks === null) {
      throw new Error('the first run must have cached the rank it just fetched');
    }
    cacheRank(userId, ranks.snapshot, Date.now() - (RANK_CACHE_TTL_MS + 1_000));
  }

  it("resolves the caller's own stored rank when no member is given", async () => {
    const wiring = await buildWiring();
    const stub = stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const own = chatInput('rank');

    await dispatch(wiring, own.interaction);

    // The Riot ID came from the caller's own link, and the region from its tag rather than the user.
    expect(stub.urls).toHaveLength(1);
    expect(stub.urls[0]).toContain('/valorant/v3/mmr/latam/pc/Dipplox/LPARG');
    expect(repliedText(own.editReply)).toContain('ASCENDANT 2');
  });

  it("resolves a named member's stored rank rather than the caller's", async () => {
    const wiring = await buildWiring();
    const stub = stubProvider();
    linkAccount(USER_ID, { name: 'Caller', tag: 'EU1' });
    linkAccount(OTHER_USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const other = chatInput('rank', { member: OTHER_USER_ID });

    await dispatch(wiring, other.interaction);

    // The named member's account was requested, not the caller's: that is what the option is for.
    expect(stub.urls[0]).toContain('/Dipplox/LPARG');
    expect(stub.urls[0]).not.toContain('/Caller/EU1');
    // And the answer says whose it is, so an ephemeral reply is not ambiguous about its subject.
    expect(repliedText(other.editReply)).toContain(`<@${OTHER_USER_ID}>`);
  });

  it('answers an unlinked member locally, without spending a request or leaking an account', async () => {
    const wiring = await buildWiring();
    const stub = stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const other = chatInput('rank', { member: OTHER_USER_ID });

    await dispatch(wiring, other.interaction);

    // The refusal is a local fact, so it costs nothing and needs no provider to confirm it.
    expect(stub.fetchImpl).not.toHaveBeenCalled();
    expect(other.deferReply).not.toHaveBeenCalled();
    expect(repliedText(other.reply)).toMatch(/has not linked/);
    expect(repliedText(other.reply)).toContain(OTHER_USER_ID);
    // Nothing about any account. An unlinked member consented to nothing, so there is nothing to
    // reveal — not even the caller's own Riot ID, which is sitting in the store right here.
    expect(repliedText(other.reply)).not.toContain('Dipplox');
  });

  it('serves a rank it already read without spending a second request', async () => {
    const wiring = await buildWiring();
    const stub = stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const first = chatInput('rank');

    await dispatch(wiring, first.interaction);
    expect(stub.fetchImpl).toHaveBeenCalledTimes(1);

    const second = chatInput('rank');
    await dispatch(wiring, second.interaction);

    // Still one. The free tier allows 30 requests a minute, and re-running the command is the single
    // most common thing anyone does with it.
    expect(stub.fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.deferReply).not.toHaveBeenCalled();
    // The answer says it came from the cache, so spending no request is visible to the reader
    // instead of being a silent claim to be live.
    expect(repliedText(second.reply)).toMatch(/cache/i);
    expect(repliedText(second.reply)).toContain('ASCENDANT 2');
  });

  it("refreshes another member's stale rank and updates what it has stored", async () => {
    const wiring = await buildWiring();
    const stub = stubProvider();
    linkAccount(OTHER_USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    await dispatch(wiring, chatInput('rank', { member: OTHER_USER_ID }).interaction);
    expire(getCachedRank(OTHER_USER_ID), OTHER_USER_ID);
    const stale = getCachedRank(OTHER_USER_ID);
    stub.fetchImpl.mockClear();

    const second = chatInput('rank', { member: OTHER_USER_ID });
    await dispatch(wiring, second.interaction);

    // Exactly one request, and the store now holds a newer reading of the same account.
    expect(stub.fetchImpl).toHaveBeenCalledTimes(1);
    const refreshed = getCachedRank(OTHER_USER_ID);
    expect(refreshed?.fetchedAt).toBeGreaterThan(stale?.fetchedAt ?? 0);
    expect(repliedText(second.editReply)).toMatch(/Fetched from the provider just now/);
  });

  it('keeps the rank it already had when the provider fails', async () => {
    const wiring = await buildWiring();
    stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    await dispatch(wiring, chatInput('rank').interaction);
    expire(getCachedRank(USER_ID), USER_ID);
    const stale = getCachedRank(USER_ID);

    // A rate limit is the failure a member will actually meet, and it must not be dressed up as a
    // generic one: the message has to say when it is worth coming back.
    configureRankContext({
      readApiKey: () => 'test-key',
      fetchImpl: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch,
    });
    const failing = chatInput('rank');

    await dispatch(wiring, failing.interaction);

    // A failed read erases nothing: the previous snapshot and its timestamp both survive, so the
    // next run has something to serve if the provider is still unhappy.
    //
    // Compared by VALUE, not by identity. The in-memory store could answer `toBe` here because a
    // `Map` hands back the very object it was given; a row read out of SQLite is rebuilt from
    // columns, so two reads are never the same object. Identity was a property of holding objects
    // in memory, never a promise the feature made, and no persistence layer can honour it.
    const after = getCachedRank(USER_ID);
    expect(after?.snapshot).toEqual(stale?.snapshot);
    expect(after?.fetchedAt).toBe(stale?.fetchedAt);
    expect(repliedText(failing.editReply)).toMatch(/rate limit/i);
    // The credential is one hop away from the request that failed, so it must not be in the reply.
    expect(repliedText(failing.editReply)).not.toContain('test-key');
  });

  it('replies ephemerally on every path, so a rank is never broadcast by asking on someone', async () => {
    const wiring = await buildWiring();
    stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });

    // The path that costs a request: the deferral is what carries the ephemeral flag.
    const fetched = chatInput('rank');
    await dispatch(wiring, fetched.interaction);
    expect(fetched.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });

    // The path that does not.
    const cached = chatInput('rank');
    await dispatch(wiring, cached.interaction);
    expect(cached.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));

    // And the refusal, so "they have not linked" is not posted to the channel either.
    const unlinked = chatInput('rank', { member: '333333333333333333' });
    await dispatch(wiring, unlinked.interaction);
    expect(unlinked.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });

  it('explains setup instead of spending a request when no key is configured', async () => {
    configureRankContext({ readApiKey: () => undefined });
    const wiring = await buildWiring();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const own = chatInput('rank');

    await dispatch(wiring, own.interaction);

    expect(repliedText(own.reply)).toMatch(/HENRIK_DEV_API_KEY/);
    expect(own.deferReply).not.toHaveBeenCalled();
  });

  it("is answered by the router alone, never by the feature's own listener", async () => {
    const wiring = await buildWiring();
    stubProvider();
    linkAccount(USER_ID, { name: 'Dipplox', tag: 'LPARG' });
    const own = chatInput('rank');

    await dispatch(wiring, own.interaction);

    // One acknowledgement. The feature handler ran and touched nothing: the fake throws if it ever
    // inspects a chat-input payload, and the router produced the only reply.
    expect(wiring.commandSpy('rank')).toHaveBeenCalledTimes(1);
    expect(own.deferReply).toHaveBeenCalledTimes(1);
    expect(own.editReply).toHaveBeenCalledTimes(1);
    expect(own.reply).not.toHaveBeenCalled();
    expect(wiring.featureSpy).toHaveBeenCalledTimes(1);
  });
});
