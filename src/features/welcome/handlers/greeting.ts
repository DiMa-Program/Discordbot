import { ChannelType, EmbedBuilder } from 'discord.js';
import type { GuildMember } from 'discord.js';

import { getGreetingSettings, isGreetingEnabled } from '../greeting-store.js';

const GREETING_COLOR = 0x5865f2;

/**
 * Greets a new member in the channel the server manager configured.
 *
 * Requires the PRIVILEGED `GuildMembers` intent: without it Discord never delivers
 * `guildMemberAdd` and this handler stays silent. `../index.ts` declares that intent so the
 * registry can warn at boot when it is missing, and the README documents the portal toggle.
 *
 * Nothing is sent unless the guild opted in, which is what keeps a freshly installed bot quiet
 * in real servers.
 */
export async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) {
    return;
  }

  const { channelId } = getGreetingSettings(member.guild.id);
  if (!isGreetingEnabled(member.guild.id) || channelId === null) {
    return;
  }

  const channel = member.guild.channels.cache.get(channelId);
  if (channel === undefined) {
    return;
  }
  // Only ever post into a text or announcement channel. Narrowing on `type` also gives
  // `channel.send` a concrete signature, instead of a union of every sendable channel.
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(GREETING_COLOR)
    .setDescription(`Welcome, <@${member.id}>! Say hello.`)
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}
