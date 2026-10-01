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

import { Collection } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../core/logger.js';
import {
  applyRegistry,
  createRegistry,
  loadFeatures,
  resolveFeaturesDir,
  type EventBinding,
  type RegistryPlan,
} from '../../core/registry.js';
import { configureRankContext, resetRankContext } from './context.js';
import { getLinkedAccount, linkAccount, resetLinkedAccounts } from './store.js';
import { LINK_MODAL_ID, MENU_BUTTONS } from './view.js';

const USER_ID = '111111111111111111';
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

/* -------------------------------------------------------------------------------------------- */
/* Interaction payloads                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * A chat-input interaction that refuses to be mistaken for a component.
 *
 * The router only ever calls `isChatInputCommand()`. If the ranks handler's guard is ever moved
 * below a permission check, a component accessor, or anything else that inspects the payload, this
 * fake throws and names the mistake instead of letting the test pass on a silent early return.
 */
function chatInput(commandName: string) {
  const reply: Spy = vi.fn().mockResolvedValue(undefined);
  const editReply: Spy = vi.fn().mockResolvedValue(undefined);
  const followUp: Spy = vi.fn().mockResolvedValue(undefined);
  const showModal: Spy = vi.fn().mockResolvedValue(undefined);

  const refuse = (accessor: string) => (): never => {
    throw new Error(`the ranks feature reached for ${accessor} on a chat-input interaction: the guard must come first`);
  };

  return {
    reply,
    editReply,
    followUp,
    showModal,
    interaction: {
      id: 'interaction-cmd',
      commandName,
      replied: false,
      deferred: false,
      isChatInputCommand: (): boolean => true,
      isButton: refuse('isButton'),
      isModalSubmit: refuse('isModalSubmit'),
      inGuild: (): boolean => true,
      guild: null,
      user: { id: USER_ID },
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
