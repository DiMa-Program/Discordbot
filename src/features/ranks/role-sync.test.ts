import { describe, expect, it, vi } from 'vitest';

import {
  applyRoleAssignment,
  ensureRankRoles,
  findRoleForTier,
  hasManageRoles,
  planRoleAssignment,
  planRoleRemoval,
  type RankRole,
  type RankRoleGateway,
} from './role-sync.js';
import { findTierByName, RANKS } from './tiers.js';

const MEMBER = '999999999999999999';

function tier(name: string) {
  const found = findTierByName(name);
  if (found === null) {
    throw new Error(`"${name}" is not a tier`);
  }
  return found;
}

function role(id: string, name: string, position = 1): RankRole {
  return { id, name, color: 0, position };
}

/**
 * A guild whose role manager records what it was asked to do.
 *
 * The mock signatures are left to inference rather than declared in an interface: a declared
 * `ReturnType<typeof vi.fn>` erases the parameters and turns every call into a type error.
 */
function fakeGuild(overrides: Partial<{ canManageRoles: boolean; botTopPosition: number }> & {
  readonly roles?: readonly RankRole[];
  readonly memberRoleIds?: readonly string[];
} = {}) {
  const state = {
    roles: [...(overrides.roles ?? [])],
    memberRoleIds: [...(overrides.memberRoleIds ?? [])],
    canManageRoles: overrides.canManageRoles ?? true,
    botTopPosition: overrides.botTopPosition ?? 50,
  };

  const fake = {
    createRole: vi.fn(async (name: string, color: number): Promise<RankRole> => {
      const created = role(`new-${state.roles.length}`, name, 1);
      state.roles.push(created);
      void color;
      return created;
    }),
    add: vi.fn(async (_memberId: string, _roleId: string): Promise<void> => undefined),
    remove: vi.fn(async (_memberId: string, _roleId: string): Promise<void> => undefined),
  };

  const gateway: RankRoleGateway = {
    canManageRoles: state.canManageRoles,
    botTopPosition: state.botTopPosition,
    listRankRoles: async () => state.roles,
    createRankRole: (name, color) => fake.createRole(name, color),
    getMemberRoleIds: async () => state.memberRoleIds,
    addMemberRole: (memberId, roleId) => fake.add(memberId, roleId),
    removeMemberRole: (memberId, roleId) => fake.remove(memberId, roleId),
  };

  return {
    gateway,
    ...fake,
    // The arrays are shared by reference, so a test can read the guild state after the fact.
    roles: state.roles,
    memberRoleIds: state.memberRoleIds,
  };
}

describe('planRoleAssignment', () => {
  const gold2 = tier('Gold 2');

  it('grants the role and strips the stale one in the same plan', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1'), role('r-gold2', 'Gold 2')],
      memberRoleIds: ['r-gold1', 'r-member'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.blockedBy).toBeNull();
    expect(plan.assignRole?.name).toBe('Gold 2');
    // Discord renders only the highest role's colour, so leaving Gold 1 behind would show the
    // wrong rank with no error anywhere.
    expect(plan.removeRoleIds).toEqual(['r-gold1']);
  });

  it('never asks to remove the role it is about to grant', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold2', 'Gold 2')],
      memberRoleIds: ['r-gold2'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.removeRoleIds).toEqual([]);
    expect(plan.assignRole?.id).toBe('r-gold2');
  });

  it('is idempotent: a second run of the same state changes nothing', () => {
    const input = {
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1'), role('r-gold2', 'Gold 2')],
      memberRoleIds: ['r-gold2'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    };

    expect(planRoleAssignment(input)).toEqual(planRoleAssignment(input));
  });

  it('leaves roles that are not rank roles alone', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-mod', 'Moderator'), role('r-gold1', 'Gold 1'), role('r-gold2', 'Gold 2')],
      memberRoleIds: ['r-mod', 'r-gold1'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.removeRoleIds).toEqual(['r-gold1']);
  });

  it('refuses without ManageRoles and says so, instead of letting a Discord 403 escape', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold2', 'Gold 2')],
      memberRoleIds: [],
      tier: gold2,
      canManageRoles: false,
      botTopPosition: 50,
    });

    expect(plan.blockedBy).toBe('missing-permission');
    expect(plan.assignRole).toBeNull();
    expect(plan.removeRoleIds).toEqual([]);
  });

  it('refuses when the rank role sits above the bot in the hierarchy', () => {
    // Discord rejects this with 403 even with ManageRoles, so it has to be predicted.
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold2', 'Gold 2', 40)],
      memberRoleIds: [],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 40,
    });

    expect(plan.blockedBy).toBe('role-hierarchy');
    expect(plan.assignRole).toBeNull();
  });

  it('allows a role strictly below the bot but not one at the same height', () => {
    const at = (position: number) =>
      planRoleAssignment({
        tiers: RANKS,
        guildRoles: [role('r-gold2', 'Gold 2', position)],
        memberRoleIds: [],
        tier: gold2,
        canManageRoles: true,
        botTopPosition: 10,
      }).blockedBy;

    expect(at(9)).toBeNull();
    expect(at(10)).toBe('role-hierarchy');
    expect(at(11)).toBe('role-hierarchy');
  });

  it('reports a tier the server has no role for, rather than granting the wrong one', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1')],
      memberRoleIds: [],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.blockedBy).toBe('role-not-created');
    expect(plan.assignRole).toBeNull();
  });

  it('reports the same for a tier that is not in the catalog at all', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold2', 'Gold 2')],
      memberRoleIds: [],
      tier: null,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.blockedBy).toBe('role-not-created');
  });

  it('removes nothing when the grant is blocked, so a stale role beats no role', () => {
    // Stripping Gold 1 when Gold 2 cannot be granted would leave the member with no rank at all,
    // which looks far more broken than a stale-but-true one.
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1', 60)],
      memberRoleIds: ['r-gold1'],
      tier: null,
      canManageRoles: true,
      botTopPosition: 10,
    });

    expect(plan.blockedBy).toBe('role-not-created');
    expect(plan.removeRoleIds).toEqual([]);
  });

  it('removes nothing when the hierarchy blocks the grant either', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1', 1), role('r-gold2', 'Gold 2', 60)],
      memberRoleIds: ['r-gold1'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 10,
    });

    expect(plan.blockedBy).toBe('role-hierarchy');
    expect(plan.removeRoleIds).toEqual([]);
  });

  it('lists every stale rank role, not just the first', () => {
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1'), role('r-iron1', 'Iron 1'), role('r-gold2', 'Gold 2')],
      memberRoleIds: ['r-iron1', 'r-gold1', 'r-gold2'],
      tier: gold2,
      canManageRoles: true,
      botTopPosition: 50,
    });

    expect(plan.removeRoleIds).toEqual(['r-gold1', 'r-iron1']);
  });
});

describe('findRoleForTier', () => {
  it('matches on the exact role name, not a case-insensitive guess', () => {
    const found = findRoleForTier(RANKS, [role('r', 'gold 2')], tier('Gold 2'));

    // A differently cased role is a hand-made role, and adopting it would be a surprise.
    expect(found).toBeNull();
  });

  it('answers null for a tier name the catalog does not own', () => {
    expect(findRoleForTier(RANKS, [role('r', 'Grandmaster')], tier('Gold 1'))).toBeNull();
  });
});

describe('planRoleRemoval', () => {
  it('strips every rank role the member holds', () => {
    const plan = planRoleRemoval({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1'), role('r-iron1', 'Iron 1')],
      memberRoleIds: ['r-gold1', 'r-iron1', 'r-mod'],
      canManageRoles: true,
    });

    expect(plan.blockedBy).toBeNull();
    expect(plan.removeRoleIds).toEqual(['r-gold1', 'r-iron1']);
  });

  it('ignores the hierarchy, so a role the bot can no longer assign is still cleared', () => {
    const plan = planRoleRemoval({
      tiers: RANKS,
      guildRoles: [role('r-gold1', 'Gold 1', 99)],
      memberRoleIds: ['r-gold1'],
      canManageRoles: true,
    });

    expect(plan.removeRoleIds).toEqual(['r-gold1']);
  });

  it('refuses without ManageRoles', () => {
    expect(
      planRoleRemoval({ tiers: RANKS, guildRoles: [], memberRoleIds: [], canManageRoles: false }).blockedBy,
    ).toBe('missing-permission');
  });
});

describe('ensureRankRoles', () => {
  it('creates all 26 roles with their catalog colours', async () => {
    const guild = fakeGuild();

    const result = await ensureRankRoles(guild.gateway);

    expect(result.blockedBy).toBeNull();
    expect(result.created).toHaveLength(26);
    expect(result.skipped).toHaveLength(0);
    expect(guild.createRole).toHaveBeenCalledTimes(26);
    expect(guild.createRole.mock.calls.map((call) => call[0])).toEqual(RANKS.map((entry) => entry.name));
    expect(guild.createRole.mock.calls.map((call) => call[1])).toEqual(RANKS.map((entry) => entry.color));
  });

  it('is idempotent: a second run creates nothing and duplicates nothing', async () => {
    const guild = fakeGuild();
    await ensureRankRoles(guild.gateway);

    const second = await ensureRankRoles(guild.gateway);

    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(26);
    expect(guild.createRole).toHaveBeenCalledTimes(26);
    expect(new Set(guild.roles.map((entry) => entry.id)).size).toBe(26);
  });

  it('creates only the roles that are missing', async () => {
    const guild = fakeGuild({ roles: [role('r1', 'Iron 1'), role('r2', 'Radiant')] });

    const result = await ensureRankRoles(guild.gateway);

    expect(result.created).toHaveLength(24);
    expect(result.skipped.map((entry) => entry.name)).toEqual(['Iron 1', 'Radiant']);
  });

  it('leaves an existing role colour alone, so an operator theme survives a re-run', async () => {
    const guild = fakeGuild({ roles: [{ ...role('r1', 'Iron 1'), color: 0x123456 }] });

    await ensureRankRoles(guild.gateway);

    expect(guild.roles[0]?.color).toBe(0x123456);
  });

  it('refuses without ManageRoles and creates nothing', async () => {
    const guild = fakeGuild({ canManageRoles: false });

    const result = await ensureRankRoles(guild.gateway);

    expect(result.blockedBy).toBe('missing-permission');
    expect(guild.createRole).not.toHaveBeenCalled();
  });
});

describe('applyRoleAssignment', () => {
  it('removes the stale role before granting the new one', async () => {
    const guild = fakeGuild({ roles: [role('r-gold1', 'Gold 1'), role('r-gold2', 'Gold 2')] });
    const calls: string[] = [];
    guild.remove.mockImplementation(async (_member: string, roleId: string) => {
      calls.push(`remove:${roleId}`);
    });
    guild.add.mockImplementation(async (_member: string, roleId: string) => {
      calls.push(`add:${roleId}`);
    });

    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: guild.roles,
      memberRoleIds: ['r-gold1'],
      tier: tier('Gold 2'),
      canManageRoles: true,
      botTopPosition: 50,
    });
    const result = await applyRoleAssignment(guild.gateway, plan, MEMBER);

    expect(calls).toEqual(['remove:r-gold1', 'add:r-gold2']);
    expect(result).toEqual({
      assignedRoleId: 'r-gold2',
      assignedRoleName: 'Gold 2',
      removedRoleIds: ['r-gold1'],
      blockedBy: null,
    });
  });

  it('does nothing at all when the plan is blocked', async () => {
    const guild = fakeGuild({ canManageRoles: false });
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: [],
      memberRoleIds: [],
      tier: tier('Gold 1'),
      canManageRoles: false,
      botTopPosition: 50,
    });

    const result = await applyRoleAssignment(guild.gateway, plan, MEMBER);

    expect(guild.add).not.toHaveBeenCalled();
    expect(guild.remove).not.toHaveBeenCalled();
    expect(result.blockedBy).toBe('missing-permission');
  });

  it('still performs the removals when there is nothing to grant', async () => {
    const guild = fakeGuild({ roles: [role('r-gold1', 'Gold 1')] });
    const plan = {
      assignRole: null,
      removeRoleIds: ['r-gold1'],
      blockedBy: null,
    };

    const result = await applyRoleAssignment(guild.gateway, plan, MEMBER);

    expect(guild.remove).toHaveBeenCalledWith(MEMBER, 'r-gold1');
    expect(guild.add).not.toHaveBeenCalled();
    expect(result.assignedRoleId).toBeNull();
  });

  it('targets the member it was given', async () => {
    const guild = fakeGuild({ roles: [role('r-gold2', 'Gold 2')] });
    const plan = planRoleAssignment({
      tiers: RANKS,
      guildRoles: guild.roles,
      memberRoleIds: [],
      tier: tier('Gold 2'),
      canManageRoles: true,
      botTopPosition: 50,
    });

    await applyRoleAssignment(guild.gateway, plan, MEMBER);

    expect(guild.add).toHaveBeenCalledWith(MEMBER, 'r-gold2');
  });
});

describe('hasManageRoles', () => {
  it('reads the ManageRoles bit and treats a missing permission object as no', () => {
    const manageRoles = 1n << 28n;

    expect(hasManageRoles({ has: (bit: bigint) => bit === manageRoles })).toBe(true);
    expect(hasManageRoles({ has: () => false })).toBe(false);
    expect(hasManageRoles(null)).toBe(false);
    expect(hasManageRoles(undefined)).toBe(false);
  });
});
