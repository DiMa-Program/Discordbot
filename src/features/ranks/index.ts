import type { Feature } from '../../core/registry.js';
import { data, execute } from './commands/menu.js';
import { handleRankInteraction } from './interaction.js';
import { createChildLogger } from '../../core/logger.js';

/**
 * VALORANT rank roles.
 *
 * Links a member's Riot ID, reads their competitive rank and keeps exactly one rank role on them.
 * Everything lives under this folder: deleting it removes the whole feature, and the only core
 * changes it depends on are the optional `HENRIK_DEV_API_KEY` env key and the `ManageRoles` bit in
 * the install link.
 *
 * NO `requiredIntents`. Every call this feature makes is a REST call, never a gateway event, so it
 * runs on the base `Guilds` intent with no Developer Portal change. The obvious extension —
 * syncing on `guildMemberAdd` — would need the privileged `GuildMembers` intent and is deliberately
 * not wired up.
 *
 * `interactionCreate` IS declared here, alongside the router `applyRegistry` binds. The two are
 * disjoint: the router handles chat input and returns early for components, this handler does the
 * reverse. `ranks.test.ts` proves it against the real registry, because a command that is deployed
 * and never routed is a bug this project has already shipped once.
 *
 * INERT WITHOUT AN API KEY. The commands still exist and the menu explains what is missing, so an
 * unconfigured bot never breaks and never has to be taken offline to add a key.
 */
const log = createChildLogger({ scope: 'ranks' });

export default {
  name: 'ranks',
  description: 'VALORANT rank roles: link a Riot ID once, get a role that follows your rank.',
  commands: [{ data, execute }],
  handlers: {
    interactionCreate: (interaction): unknown => handleRankInteraction(interaction, log),
  },
} satisfies Feature;
