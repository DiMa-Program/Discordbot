import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

/**
 * `/ping` — liveness check.
 *
 * The smallest possible proof that the extension path works end to end: a folder, a command
 * payload, a handler, and nothing in `core/` changed to make it work.
 */
export const data = new SlashCommandBuilder()
  .setName('ping')
  .setDescription('Check that the bot is connected and responsive.')
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // ws.ping is -1 before the heartbeat starts, so clamp it rather than printing a negative.
  const heartbeatMs = Math.max(0, Math.round(interaction.client.ws.ping));
  await interaction.reply({ content: `Pong! Gateway heartbeat: ${heartbeatMs} ms.` });
}
