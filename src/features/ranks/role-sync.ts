/**
 * Rank role creation and assignment.
 *
 * SPLIT INTO A PLANNER AND AN EXECUTOR ON PURPOSE.
 *
 * `planRoleAssignment` is pure: given the guild's roles, the member's roles and the tier, it
 * returns what to create, what to remove and what to assign, or why nothing can be done yet. Every
 * interesting rule — remove the old rank role first, refuse without `ManageRoles`, refuse when the
 * hierarchy puts the role above the bot — is testable without a Discord client, a token or a
 * gateway connection. `applyRoleAssignment` is the thin part that talks to Discord.
 *
 * WHY THE OLD ROLE MUST BE REMOVED FIRST.
 *
 * Discord renders the colour of the single highest role a member holds, not a merge of all of
 * them. A member who was Gold 1 yesterday and is Gold 2 today who keeps both roles still displays
 * as Gold 1, because Gold 1 sits higher in the ladder ordering the roles were created in. The
 * feature would look broken forever with no error anywhere, so removal is part of the assignment,
 * not a cleanup pass.
 */

import { PermissionFlagsBits } from 'discord.js';
import type { Guild, Role } from 'discord.js';

import { RANKS, type RankTier } from './tiers.js';

/** A role as this module needs to see it. Narrower than a discord.js `Role` so tests can fake it. */
export interface RankRole {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  /** Discord hierarchy position. A bot can only touch roles strictly below its own highest. */
  readonly position: number;
}

/**
 * The role operations this feature needs, expressed as the smallest possible surface.
 *
 * Keeping the discord.js objects behind this interface is what lets the assignment rules be tested
 * for real instead of mocked at the `guild.roles.add` call site.
 */
export interface RankRoleGateway {
  /** False when the bot lacks `ManageRoles`, or when the cache has not told us yet. */
  readonly canManageRoles: boolean;
  /** Position of the bot's own highest role. Rank roles must sit strictly below it. */
  readonly botTopPosition: number;
  /** Every role in the guild that carries a rank role name, whether or not the bot can touch it. */
  listRankRoles(): Promise<readonly RankRole[]>;
  createRankRole(name: string, color: number): Promise<RankRole>;
  getMemberRoleIds(memberId: string): Promise<readonly string[]>;
  addMemberRole(memberId: string, roleId: string): Promise<void>;
  removeMemberRole(memberId: string, roleId: string): Promise<void>;
}

/** Why an assignment cannot be carried out. Each maps to its own remediation message. */
export type RoleSyncBlocker =
  | 'missing-permission'
  | 'role-hierarchy'
  | 'role-not-created';

export interface RoleAssignmentPlan {
  /** The role to grant, or `null` when the tier has no role in this server yet. */
  readonly assignRole: RankRole | null;
  /** Role ids to strip from the member first. Never includes the target role. */
  readonly removeRoleIds: readonly string[];
  /** Set when the plan cannot be executed; `null` when it can. */
  readonly blockedBy: RoleSyncBlocker | null;
}

export interface PlanRoleAssignmentInput {
  readonly tiers: readonly RankTier[];
  readonly guildRoles: readonly RankRole[];
  readonly memberRoleIds: readonly string[];
  /** `null` when the provider named a tier this build has no role for. */
  readonly tier: RankTier | null;
  readonly canManageRoles: boolean;
  readonly botTopPosition: number;
}

/**
 * Decides what to do to a member's rank roles for one tier. Pure.
 *
 * Order of the checks is the order of the user-facing remediation, and it matters: a bot without
 * `ManageRoles` must be told that first, because "move the bot's role up" does not help someone
 * who has not granted the permission in the first place.
 *
 * A BLOCKED PLAN REMOVES NOTHING. Stripping the old rank role when the new one cannot be granted
 * would leave the member with no rank at all — an obviously wrong state — instead of a slightly
 * stale one that at least still shows something true. `planRoleRemoval` is the exception, because
 * there removal is the whole point.
 */
export function planRoleAssignment(input: PlanRoleAssignmentInput): RoleAssignmentPlan {
  if (!input.canManageRoles) {
    return blocked('missing-permission');
  }

  const assignRole = input.tier === null ? null : findRoleForTier(input.tiers, input.guildRoles, input.tier);
  if (assignRole === null) {
    return blocked('role-not-created');
  }
  if (assignRole.position >= input.botTopPosition) {
    return blocked('role-hierarchy');
  }

  return {
    assignRole,
    removeRoleIds: rankRoleIdsToRemove(input.tiers, input.guildRoles, input.memberRoleIds, assignRole),
    blockedBy: null,
  };
}

function blocked(blockedBy: RoleSyncBlocker): RoleAssignmentPlan {
  return { assignRole: null, removeRoleIds: [], blockedBy };
}

export interface PlanRoleRemovalInput {
  readonly tiers: readonly RankTier[];
  readonly guildRoles: readonly RankRole[];
  readonly memberRoleIds: readonly string[];
  readonly canManageRoles: boolean;
}

/**
 * Decides what to strip from a member when they unlink. Pure.
 *
 * A member can hold a rank role the bot can no longer assign (hierarchy moved under it), and
 * unlinking must still be able to clean that up, so removal ignores the position check entirely.
 */
export function planRoleRemoval(input: PlanRoleRemovalInput): RoleAssignmentPlan {
  if (!input.canManageRoles) {
    return blocked('missing-permission');
  }
  return {
    assignRole: null,
    removeRoleIds: rankRoleIdsToRemove(input.tiers, input.guildRoles, input.memberRoleIds, null),
    blockedBy: null,
  };
}

/** The role in `guildRoles` whose name exactly matches the tier's. Roles are matched by name. */
export function findRoleForTier(
  tiers: readonly RankTier[],
  guildRoles: readonly RankRole[],
  tier: RankTier,
): RankRole | null {
  const rankRoleNames = new Set(tiers.map((candidate) => candidate.name));
  const wanted = rankRoleNames.has(tier.name) ? tier.name : null;
  if (wanted === null) {
    return null;
  }
  return guildRoles.find((role) => role.name === wanted) ?? null;
}

function rankRoleIdsToRemove(
  tiers: readonly RankTier[],
  guildRoles: readonly RankRole[],
  memberRoleIds: readonly string[],
  keep: RankRole | null,
): string[] {
  const rankRoleNames = new Set(tiers.map((tier) => tier.name));
  const held = new Set(memberRoleIds);
  const remove: string[] = [];
  for (const role of guildRoles) {
    if (!rankRoleNames.has(role.name)) {
      continue;
    }
    if (keep !== null && role.id === keep.id) {
      continue;
    }
    if (held.has(role.id) && !remove.includes(role.id)) {
      remove.push(role.id);
    }
  }
  return remove;
}

export interface EnsureRankRolesResult {
  /** Tiers that had no role and now do, with the id Discord assigned. */
  readonly created: ReadonlyArray<{ readonly tier: RankTier; readonly roleId: string }>;
  /** Tiers whose role already existed. */
  readonly skipped: readonly RankTier[];
  readonly blockedBy: RoleSyncBlocker | null;
}

/**
 * Creates every missing rank role. Idempotent: a role that already exists is never re-created and
 * never re-coloured, so running the button twice produces a second identical list rather than 50
 * duplicate roles.
 *
 * Existing roles are matched by exact name and their colour is deliberately left alone. An
 * operator who has themed the colours should not have them silently overwritten by a member who
 * pressed a button.
 */
export async function ensureRankRoles(gateway: RankRoleGateway): Promise<EnsureRankRolesResult> {
  if (!gateway.canManageRoles) {
    return { created: [], skipped: [], blockedBy: 'missing-permission' };
  }

  const guildRoles = await gateway.listRankRoles();
  const existing = new Set(guildRoles.map((role) => role.name));
  const created: Array<{ tier: RankTier; roleId: string }> = [];
  const skipped: RankTier[] = [];

  for (const tier of RANKS) {
    if (existing.has(tier.name)) {
      skipped.push(tier);
      continue;
    }
    const role = await gateway.createRankRole(tier.name, tier.color);
    created.push({ tier, roleId: role.id });
    // Newly created roles land at the bottom of the hierarchy, so `existing` must not be assumed
    // to have grown on its own: an unranked role and a ranked one can share a display name in a
    // hand-made server, and the catalog is the authority on which names are rank roles.
    existing.add(tier.name);
  }

  return { created, skipped, blockedBy: null };
}

export interface ApplyRoleAssignmentResult {
  readonly assignedRoleId: string | null;
  readonly assignedRoleName: string | null;
  readonly removedRoleIds: readonly string[];
  readonly blockedBy: RoleSyncBlocker | null;
}

/**
 * Executes a plan: strip the stale rank roles, then grant the new one.
 *
 * Removal happens before assignment on purpose. If the grant then fails, the member is left with
 * no rank role and the UI says so — an obviously wrong state — instead of keeping a rank role that
 * is silently too low, which is the state users report as "the bot is broken".
 */
export async function applyRoleAssignment(
  gateway: RankRoleGateway,
  plan: RoleAssignmentPlan,
  memberId: string,
): Promise<ApplyRoleAssignmentResult> {
  if (plan.blockedBy !== null) {
    return { assignedRoleId: null, assignedRoleName: null, removedRoleIds: [], blockedBy: plan.blockedBy };
  }

  for (const roleId of plan.removeRoleIds) {
    await gateway.removeMemberRole(memberId, roleId);
  }

  const assignRole = plan.assignRole;
  if (assignRole === null) {
    return { assignedRoleId: null, assignedRoleName: null, removedRoleIds: plan.removeRoleIds, blockedBy: null };
  }

  await gateway.addMemberRole(memberId, assignRole.id);
  return {
    assignedRoleId: assignRole.id,
    assignedRoleName: assignRole.name,
    removedRoleIds: plan.removeRoleIds,
    blockedBy: null,
  };
}

/** `ManageRoles`, expressed as a predicate so callers do not have to import discord.js to ask. */
export function hasManageRoles(permissions: { has(bit: bigint): boolean } | null | undefined): boolean {
  return permissions?.has(PermissionFlagsBits.ManageRoles) === true;
}

function toRankRole(role: Role): RankRole {
  return { id: role.id, name: role.name, color: role.color, position: role.position };
}

/**
 * Wraps a guild's role manager in the narrow gateway the planner and executor expect.
 *
 * `canManageRoles` is read from the cached guild member rather than assumed from the invite
 * bitfield: the permission can be revoked after installation, and a stale bit would turn a clear
 * "grant Manage Roles" message into an opaque Discord 403.
 */
export function createGuildRoleGateway(guild: Guild): RankRoleGateway {
  const me = guild.members.me;
  return {
    canManageRoles: hasManageRoles(me?.permissions),
    botTopPosition: me?.roles.highest?.position ?? 0,
    listRankRoles: async () => {
      const names = new Set(RANKS.map((tier) => tier.name));
      return [...guild.roles.cache.values()].filter((role) => names.has(role.name)).map(toRankRole);
    },
    createRankRole: async (name, color) => {
      // `colors.primaryColor` rather than the deprecated `color`: the API still returns `color` and
      // still accepts it, but the field is on its way out.
      const created = await guild.roles.create({ name, colors: { primaryColor: color } });
      return toRankRole(created);
    },
    getMemberRoleIds: async (memberId) => {
      const member = await guild.members.fetch(memberId);
      return [...member.roles.cache.keys()];
    },
    addMemberRole: async (memberId, roleId) => {
      const member = await guild.members.fetch(memberId);
      await member.roles.add(roleId, 'VALORANT rank role sync');
    },
    removeMemberRole: async (memberId, roleId) => {
      const member = await guild.members.fetch(memberId);
      await member.roles.remove(roleId, 'VALORANT rank role sync');
    },
  };
}
