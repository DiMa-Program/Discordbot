import { OAuth2Scopes, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  AUTHORIZE_ENDPOINT,
  buildInstallUrl,
  describePermissionGrants,
  FORBIDDEN_PERMISSIONS,
  INSTALL_SCOPES,
  PERMISSION_GRANTS,
  permissionName,
  REQUIRED_PERMISSIONS,
  resolvePermissionBits,
} from './permissions.js';

describe('least-privilege permission set', () => {
  it('never requests a forbidden permission', () => {
    for (const forbidden of FORBIDDEN_PERMISSIONS) {
      expect(REQUIRED_PERMISSIONS).not.toContain(forbidden);
    }
  });

  it('stays at the granular set the shipped features actually need', () => {
    expect(REQUIRED_PERMISSIONS).toEqual([
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.EmbedLinks,
    ]);
  });

  it('documents a reason for every requested permission', () => {
    expect(PERMISSION_GRANTS.length).toBe(REQUIRED_PERMISSIONS.length);
    for (const grant of PERMISSION_GRANTS) {
      expect(grant.reason.length).toBeGreaterThan(20);
    }
  });

  it('ORs the flags into the bitfield Discord expects', () => {
    // SendMessages (2048) | EmbedLinks (16384)
    expect(resolvePermissionBits()).toBe(2048n | 16384n);
    expect(resolvePermissionBits().toString()).toBe('18432');
  });

  it('refuses to build a bitfield that contains a forbidden permission', () => {
    expect(() => resolvePermissionBits([PermissionsBitField.Flags.Administrator])).toThrow(
      /Refusing to request forbidden permission/,
    );
    expect(() => resolvePermissionBits([PermissionsBitField.Flags.ManageGuild])).toThrow(
      /Refusing to request forbidden permission/,
    );
  });
});

describe('install scopes', () => {
  it('requests both the bot and application-commands scopes', () => {
    // applications.commands is what makes slash commands visible; bot installs the app.
    expect(INSTALL_SCOPES).toEqual([OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands]);
  });
});

describe('buildInstallUrl', () => {
  it('points at the OAuth2 authorization endpoint with the granular bitfield', () => {
    const url = new URL(buildInstallUrl('123456789012345678'));
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get('client_id')).toBe('123456789012345678');
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(url.searchParams.get('permissions')).toBe('18432');
  });

  it('matches the URL shape discord.js itself produces', () => {
    // Client#generateInvite builds `?client_id=..&scope=..&permissions=..` in that order.
    const query = new URL(buildInstallUrl('123456789012345678')).search;
    expect(query).toBe('?client_id=123456789012345678&scope=bot+applications.commands&permissions=18432');
  });

  it('never emits the Administrator bit, alone or as part of a full-admin set', () => {
    // Administrator is 0x8; a full administrator bitfield is 0x8n. Neither may appear.
    const bits = resolvePermissionBits();
    expect(bits & PermissionsBitField.Flags.Administrator).toBe(0n);
    expect(buildInstallUrl('123456789012345678')).not.toContain('permissions=8');
  });

  it('omits disable_guild_select unless it was requested', () => {
    expect(buildInstallUrl('1')).not.toContain('disable_guild_select');
    expect(new URL(buildInstallUrl('1', { disableGuildSelect: true })).searchParams.get('disable_guild_select')).toBe(
      'true',
    );
  });

  it('rejects a scope set that cannot install the bot', () => {
    expect(() => buildInstallUrl('1', { scopes: [OAuth2Scopes.ApplicationsCommands] })).toThrow(
      /scope is required/,
    );
  });

  it('rejects forbidden permissions even when passed explicitly', () => {
    expect(() =>
      buildInstallUrl('1', { permissions: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Administrator] }),
    ).toThrow(/Refusing to request forbidden permission/);
  });
});

describe('describePermissionGrants', () => {
  it('prints each permission with its reason', () => {
    const lines = describePermissionGrants();
    expect(lines).toHaveLength(REQUIRED_PERMISSIONS.length);
    expect(lines.join('\n')).toContain('SendMessages');
    expect(lines.join('\n')).toContain('EmbedLinks');
  });

  it('never renders a permission as "[object Object]"', () => {
    // Regression guard: PermissionsBitField#toString() renders that way for a raw bit, so the
    // name has to come from an explicit reverse lookup.
    expect(describePermissionGrants().join('\n')).not.toContain('[object Object]');
  });
});

describe('permissionName', () => {
  it('resolves bit values to their Discord names', () => {
    expect(permissionName(PermissionsBitField.Flags.SendMessages)).toBe('SendMessages');
    expect(permissionName(PermissionsBitField.Flags.EmbedLinks)).toBe('EmbedLinks');
    expect(permissionName(PermissionsBitField.Flags.Administrator)).toBe('Administrator');
  });

  it('falls back to the numeric value for an unknown bit', () => {
    expect(permissionName(1n << 62n)).toBe(String(1n << 62n));
  });
});
