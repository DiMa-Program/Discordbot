/**
 * Prints the OAuth2 install link.
 *
 * Needs only `DISCORD_CLIENT_ID`, and deliberately not the bot token: `Client#generateInvite`
 * requires a logged-in client, and the URL is pure data derived from the application id and the
 * permission set. Anyone building the link can therefore do it before the bot has ever run.
 *
 * Run it with: npm run invite
 */

import { formatEnvIssues, loadInstallLinkEnv } from '../config/env.js';
import {
  buildInstallUrl,
  describePermissionGrants,
  FORBIDDEN_PERMISSIONS,
  INSTALL_SCOPES,
  permissionName,
  REQUIRED_PERMISSIONS,
} from '../core/permissions.js';

function main(): void {
  const env = loadInstallLinkEnv();
  if (!env.ok) {
    process.stderr.write(`\n${formatEnvIssues(env.issues)}\n\n`);
    process.exitCode = 1;
    return;
  }

  const url = buildInstallUrl(env.clientId);
  const forbidden = FORBIDDEN_PERMISSIONS.map((permission) => permissionName(permission));

  process.stdout.write(
    [
      'Install this bot into a server by opening this URL:',
      '',
      `  ${url}`,
      '',
      'Requested OAuth2 scopes:',
      ...INSTALL_SCOPES.map((scope) => `  - ${scope}`),
      '',
      'Requested channel permissions:',
      ...describePermissionGrants(REQUIRED_PERMISSIONS),
      '',
      `Deliberately not requested: ${forbidden.join(', ')}.`,
      '',
      'Discord shows the requested permissions on the consent screen, so the server owner can',
      'see exactly what the bot will be able to do before approving it.',
      '',
    ].join('\n'),
  );
}

main();
