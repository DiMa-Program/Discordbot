import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { createChildLogger } from '../../../core/logger.js';
import { executeMenuCommand } from '../interaction.js';

/**
 * `/menu` — the VALORANT rank menu, and the feature's only command.
 *
 * No arguments, and no `default_member_permissions`: every member links and reads their own rank,
 * so restricting the command would hide the feature from exactly the people it is for. The one
 * privileged action in the flow (creating the 25 rank roles) is a button gated at runtime, because
 * Discord does not support `default_member_permissions` on a button.
 *
 * The command payload lives here and not in `interaction.ts` because `deploy-commands.ts` scans
 * `commands/` for anything exporting `data` + `execute`, while the runtime manifest in
 * `../index.ts` is what the registry routes. Both must list the same command, or deployment refuses
 * to publish.
 */
export const data = new SlashCommandBuilder()
  .setName('menu')
  .setDescription('Link your VALORANT account and manage your rank role.')
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
  await executeMenuCommand(interaction, featureLog());
}
