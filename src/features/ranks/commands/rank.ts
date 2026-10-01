import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { createChildLogger } from '../../../core/logger.js';
import { executeRankCommand } from '../interaction.js';

/**
 * `/rank` — the rank of a member who has already linked an account.
 *
 * ONE OPTION, AND IT IS A USER. The absence of a string option is the design, not an omission:
 *
 *   - The provider's terms do not support analytic lookups the user has not consented to, and Riot's
 *     policy does not let a player's data be exposed without opt-in. A Riot ID parameter would let
 *     anyone ask about anyone, which is the exact bypass the link flow exists to prevent.
 *   - A Riot ID typed into a command is also a Riot ID another member can read off the screen, which
 *     makes the consent the link represents considerably weaker.
 *
 * So the only way in is a Discord user, and a member without a link is answered locally rather than
 * looked up. See `executeRankCommand` in `../interaction.ts` for the runtime half of that rule.
 *
 * No `default_member_permissions`, and deliberately so: reading the rank of a member who linked is
 * public within the guild, because linking is the consent. A gate would hide the command from
 * exactly the people who linked, and the reply is ephemeral either way.
 */
export const data = new SlashCommandBuilder()
  .setName('rank')
  .setDescription("Show a member's VALORANT rank. Leave the member empty for your own.")
  .addUserOption((option) =>
    option
      .setName('member')
      .setDescription('Whose rank to show. Leave empty for your own.')
      .setRequired(false),
  )
  .toJSON();

/**
 * One logger for the whole feature, created on first use.
 *
 * `createChildLogger` builds a pino instance, so it is memoised rather than called per
 * interaction: a feature that logged a new instance per click would leak handles under load.
 */
let log: ReturnType<typeof createChildLogger> | null = null;

function featureLog(): ReturnType<typeof createChildLogger> {
  log ??= createChildLogger({ scope: 'ranks' });
  return log;
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await executeRankCommand(interaction, featureLog());
}
