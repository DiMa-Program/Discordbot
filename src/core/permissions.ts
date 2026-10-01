/**
 * OAuth2 install configuration — the single source of truth for the install link.
 *
 * The permission list is plain data plus pure functions, so unit tests can assert on it without
 * constructing a Discord client or holding a bot token.
 *
 * Why this is not just a list of flags: `Client#generateInvite` in discord.js 14 requires a
 * logged-in client, which would force anyone printing an install link to boot the bot first.
 * The URL format below mirrors the library's own output exactly, so the link is valid and the
 * permission data stays testable.
 *
 * Rules encoded in this module:
 *   - `Administrator` is never requested. It is a hard error, not a warning.
 *   - `Manage Server` is never requested at install time. Features that need it check the
 *     caller's permission at runtime instead (see features/welcome/commands/config-greeting.ts).
 *   - Every requested permission carries a written reason, so a reviewer can audit the diff
 *     instead of guessing why a bit is set.
 */

import { OAuth2Scopes, PermissionFlagsBits } from 'discord.js';

/**
 * A single Discord permission bit.
 *
 * discord.js 14 models permissions as a bitfield, so an individual permission is a `bigint`
 * (for example `SendMessages` is `2048n`). `PermissionFlagsBits` is a value-only constant map
 * with no companion type, hence this alias rather than a bare `bigint` everywhere.
 */
export type DiscordPermission = bigint;

const PERMISSION_NAMES: ReadonlyMap<bigint, string> = buildPermissionNames();

function buildPermissionNames(): ReadonlyMap<bigint, string> {
  // `PermissionFlagsBits` is a name -> bigint map with no numeric reverse entries, and
  // `new PermissionsBitField(bits).toString()` renders "[object Object]". So the reverse lookup
  // is built explicitly, which is what makes the error and report output readable.
  const names = new Map<bigint, string>();
  for (const [name, bits] of Object.entries(PermissionFlagsBits)) {
    if (typeof bits === 'bigint') {
      names.set(bits, name);
    }
  }
  return names;
}

/** Human-readable name for a permission bit, falling back to its numeric value. */
export function permissionName(permission: DiscordPermission): string {
  return PERMISSION_NAMES.get(permission) ?? String(permission);
}

/** Discord's OAuth2 authorization endpoint. */
export const AUTHORIZE_ENDPOINT = 'https://discord.com/oauth2/authorize';

/**
 * Scopes requested at install time.
 * `bot` installs the application; `applications.commands` is what makes slash commands visible
 * to members. Without the second scope the bot installs but no command ever appears.
 */
export const INSTALL_SCOPES: readonly OAuth2Scopes[] = [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands];

/** A requested channel permission together with the reason it is needed. */
export interface PermissionGrant {
  readonly permission: DiscordPermission;
  readonly reason: string;
}

/**
 * The complete install-time permission set.
 *
 * `SendMessages` covers slash-command replies and the opt-in welcome greeting.
 * `EmbedLinks` covers rich command replies.
 * `ManageRoles` covers creating the VALORANT rank roles and applying the right one to a member.
 *
 * `ManageRoles` is requested at install time rather than checked at runtime only, because a
 * server owner has to grant it through the OAuth2 consent screen or the bot cannot ever create
 * the roles it is built to manage. It is still the narrowest bit that does the job: it grants no
 * ability to touch anything except roles, and the role hierarchy check in
 * `features/ranks/role-sync.ts` still applies on top of it.
 */
export const PERMISSION_GRANTS: readonly PermissionGrant[] = [
  {
    permission: PermissionFlagsBits.SendMessages,
    reason: 'Reply to slash commands and post the opt-in welcome greeting.',
  },
  {
    permission: PermissionFlagsBits.EmbedLinks,
    reason: 'Render command replies as rich embeds instead of plain text.',
  },
  {
    permission: PermissionFlagsBits.ManageRoles,
    reason: 'Create the VALORANT rank roles and keep the correct one assigned to each member.',
  },
];

/** Flattened permission list derived from `PERMISSION_GRANTS`, so the two cannot drift. */
export const REQUIRED_PERMISSIONS: readonly DiscordPermission[] = PERMISSION_GRANTS.map(
  (grant) => grant.permission,
);

/**
 * Permissions this project refuses to request at install time.
 * Requesting them is treated as a programming error and throws.
 */
export const FORBIDDEN_PERMISSIONS: readonly DiscordPermission[] = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
];

export interface InstallUrlOptions {
  readonly permissions?: readonly DiscordPermission[];
  readonly scopes?: readonly OAuth2Scopes[];
  readonly endpoint?: string;
  /** Pre-selects a single guild in the install dialog. */
  readonly disableGuildSelect?: boolean;
}

/**
 * ORs permissions into the bitfield Discord expects, rejecting forbidden flags.
 *
 * @throws if any requested permission is in `FORBIDDEN_PERMISSIONS`.
 */
export function resolvePermissionBits(
  permissions: readonly DiscordPermission[] = REQUIRED_PERMISSIONS,
): bigint {
  const violations = permissions.filter((permission) => FORBIDDEN_PERMISSIONS.includes(permission));
  if (violations.length > 0) {
    const names = violations.map((permission) => permissionName(permission)).join(', ');
    throw new Error(`Refusing to request forbidden permission(s): ${names}`);
  }
  return permissions.reduce((bits, permission) => bits | permission, 0n);
}

/**
 * Builds the OAuth2 install URL for an application.
 *
 * @throws if `bot` is missing from the scopes, or a forbidden permission is requested.
 */
export function buildInstallUrl(clientId: string, options: InstallUrlOptions = {}): string {
  const scopes = options.scopes ?? INSTALL_SCOPES;
  if (!scopes.includes(OAuth2Scopes.Bot)) {
    throw new Error(`The "${OAuth2Scopes.Bot}" scope is required to install the application into a server.`);
  }

  const query = new URLSearchParams();
  query.set('client_id', clientId);
  query.set('scope', scopes.join(' '));
  query.set('permissions', resolvePermissionBits(options.permissions).toString());
  if (options.disableGuildSelect === true) {
    query.set('disable_guild_select', 'true');
  }

  return `${options.endpoint ?? AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

/** Human-readable breakdown of the permission set, for the install-link script output. */
export function describePermissionGrants(
  permissions: readonly DiscordPermission[] = REQUIRED_PERMISSIONS,
): string[] {
  return permissions.map((permission) => {
    const label = permissionName(permission);
    const reason = PERMISSION_GRANTS.find((grant) => grant.permission === permission)?.reason;
    return reason === undefined ? `  - ${label}` : `  - ${label} — ${reason}`;
  });
}
