import { GatewayIntentBits } from 'discord.js';

import type { Feature } from '../../core/registry.js';
import { data, execute } from './commands/config-greeting.js';
import { handleGuildMemberAdd } from './handlers/greeting.js';

/**
 * Reference feature for event handling.
 *
 * `GuildMembers` is PRIVILEGED: it is off in the Developer Portal by default, so the registry
 * reports a missing intent at boot until both the portal toggle and `ENABLE_PRIVILEGED_INTENTS`
 * are set. Greetings stay off per guild until `/config-greeting` turns them on, so installing
 * this bot in a real server never produces surprise messages.
 */
export default {
  name: 'welcome',
  description: 'Optional member greeting, disabled until a server manager enables it.',
  commands: [{ data, execute }],
  handlers: { guildMemberAdd: handleGuildMemberAdd },
  requiredIntents: [GatewayIntentBits.GuildMembers],
} satisfies Feature;
