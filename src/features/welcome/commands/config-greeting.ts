import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';

import { configureGreeting, getGreetingSettings } from '../greeting-store.js';

/**
 * `/config-greeting` — turn the welcome greeting on or off for the current server.
 *
 * Least privilege, twice over:
 *   - `setDefaultMemberPermissions` makes Discord hide the command from members who cannot
 *     manage the server, so it does not clutter the command picker for everyone else.
 *   - the explicit check below rejects anyone who reaches it through a cached command list.
 * Neither requires the bot to be installed with the Manage Server permission.
 */
export const data = new SlashCommandBuilder()
  .setName('config-greeting')
  .setDescription('Turn the welcome greeting on or off for this server.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addBooleanOption((option) =>
    option
      .setName('enabled')
      .setDescription('Whether new members are greeted.')
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName('channel')
      .setDescription('Where the greeting is posted. Leave empty to keep the current channel.')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  )
  .toJSON();

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
    return;
  }

  const permissions = interaction.memberPermissions;
  if (permissions === null || !permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'You need the Manage Server permission to change this setting.',
      ephemeral: true,
    });
    return;
  }

  const enabled = interaction.options.getBoolean('enabled', true);
  const current = getGreetingSettings(interaction.guildId);

  if (!enabled) {
    configureGreeting(interaction.guildId, { enabled: false, channelId: current.channelId });
    await interaction.reply({
      content: 'Welcome greetings are now disabled for this server.',
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel');
  if (channel === null) {
    await interaction.reply({
      content: 'Pass a `channel` option the first time you enable greetings.',
      ephemeral: true,
    });
    return;
  }

  configureGreeting(interaction.guildId, { enabled: true, channelId: channel.id });
  await interaction.reply({
    content: `New members will be greeted in <#${channel.id}>.`,
    ephemeral: true,
  });
}
