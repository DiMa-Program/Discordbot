import { GatewayIntentBits } from 'discord.js';

import type { Feature } from '../../core/registry.js';
import { data as menuCommand, execute as runMenu } from './commands/menu.js';
import { data as rankCommand, execute as runRank } from './commands/rank.js';
import { handleRankInteraction } from './interaction.js';
import { handleGuildMemberAdd as promptOnJoin } from './prompt.js';
import { createChildLogger } from '../../core/logger.js';

/**
 * VALORANT rank roles.
 *
 * Links a member's Riot ID, reads their competitive rank and keeps exactly one rank role on them.
 * `/menu` is where the linking happens; `/rank` is the one-tap read, for a member's own rank or for
 * somebody else's who has already linked. Everything lives under this folder: deleting it removes
 * the whole feature, and the only core changes it depends on are the optional `HENRIK_DEV_API_KEY`
 * and `RANK_SYNC_INTERVAL_MINUTES` env keys and the `ManageRoles` bit in the install link.
 *
 * BOTH COMMANDS MUST BE LISTED HERE AND IN `commands/`. `deploy-commands.ts` reads `commands/` to
 * decide what to publish and this array to decide what has a handler behind it, and it refuses to
 * deploy when the two disagree — so a command added to one and not the other is a build failure
 * rather than a command that silently does nothing.
 *
 * `GuildMembers` IS DECLARED, AND IT IS PRIVILEGED. `guildMemberAdd` never arrives without it, so a
 * feature that listens for that event has to say so or it would fail silently. It is off in the
 * Developer Portal by default and is only requested when `ENABLE_PRIVILEGED_INTENTS=true`, which is
 * what keeps a fresh install working with no portal changes. The `welcome` feature declares the same
 * intent for its own handler; declaring one intent twice is not a conflict, and the boot diagnostics
 * list it once.
 *
 * TWO `interactionCreate`-DECLARED HANDLERS WOULD BE IMPOSSIBLE, WHICH IS WHY THERE IS ONE LISTENER.
 * `handlers` is a map keyed by event name, so a feature can bind `interactionCreate` exactly once and
 * must answer chat input, buttons and modals from inside it. `interaction.ts` does that, and the
 * join prompt's two buttons are two more cases in its switch — not a second listener, and not a
 * second modal. `ranks.test.ts` proves the disjointness against the real registry, because a command
 * that is deployed and never routed is a bug this project has already shipped once.
 *
 * THE PERIODIC PASS IS NOT DECLARED HERE. `sync.ts` needs the configured interval and a live client,
 * and the registry builds features with no configuration argument — that is what keeps "add a folder"
 * the whole extension path. `src/index.ts` therefore starts it after the client is built, the same
 * seam `context.ts` uses for the API key.
 *
 * INERT WITHOUT AN API KEY. The commands still exist and explain what is missing, so an
 * unconfigured bot never breaks and never has to be taken offline to add a key.
 */
const log = createChildLogger({ scope: 'ranks' });

export default {
  name: 'ranks',
  description: 'VALORANT rank roles: link a Riot ID once, get a role that follows your rank.',
  commands: [
    { data: menuCommand, execute: runMenu },
    { data: rankCommand, execute: runRank },
  ],
  handlers: {
    interactionCreate: (interaction): unknown => handleRankInteraction(interaction, log),
    guildMemberAdd: (member): unknown => promptOnJoin(member, log),
  },
  requiredIntents: [GatewayIntentBits.GuildMembers],
} satisfies Feature;