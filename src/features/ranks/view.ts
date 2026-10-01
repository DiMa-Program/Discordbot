/**
 * The `/menu` view: what a member sees, and the buttons that get them there.
 *
 * Every reply is ephemeral. A rank is nobody's business but the member who earned it, and Discord
 * makes ephemeral replies free, so there is no reason to post one publicly and then delete it.
 *
 * ONE INPUT FIELD, NOT A REGION PICKER. Discord modals accept only text inputs — a select menu
 * cannot be placed inside one — so the link modal takes a single Riot ID and the region is inferred
 * from its tag. A dropdown would need a second command, which is exactly the friction this feature
 * exists to remove.
 *
 * `default_member_permissions` CANNOT restrict these buttons. Discord honours that field on a slash
 * command payload, or on an action row that contains a select menu. A button row is neither, so
 * setting it would be a no-op that reads in the source as protection the user does not have. The
 * admin action is therefore enforced at runtime in `interaction.ts`, where a stale Discord-side
 * command config cannot bypass the check.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';

import { NOT_CONFIGURED_MESSAGE } from './messages.js';
import type { RankSnapshot } from './provider.js';
import type { LinkedAccount } from './store.js';

/** Component custom ids. Namespaced so a future feature cannot collide with them. */
export const MENU_BUTTONS = {
  link: 'rank:link',
  refresh: 'rank:refresh',
  unlink: 'rank:unlink',
  createRoles: 'rank:create-roles',
} as const;

/** The modal the link button opens, and the one field inside it. */
export const LINK_MODAL_ID = 'rank:link-modal';
export const RIOT_ID_FIELD = 'riot-id';

const ACCENT = 0x6ae2af;
const MUTED = 0x868986;

/** How the menu should be rendered, derived once and then handed to the view. */
export type MenuViewState =
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'unlinked' }
  | {
      readonly kind: 'linked';
      readonly account: LinkedAccount;
      /** `null` when the member has linked but never refreshed. */
      readonly snapshot: RankSnapshot | null;
    };

/** A built menu: an embed, its buttons, and the flags a reply needs. */
export interface MenuView {
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
  readonly flags: number;
}

/** Renders whichever of the three states the member is in. */
export function buildMenuView(state: MenuViewState): MenuView {
  switch (state.kind) {
    case 'not-configured':
      return notConfiguredView();
    case 'unlinked':
      return unlinkedView();
    case 'linked':
      return state.snapshot === null ? linkedWithoutRankView(state.account) : linkedView(state.account, state.snapshot);
  }
}

function notConfiguredView(): MenuView {
  const embed = new EmbedBuilder()
    .setColor(MUTED)
    .setTitle('VALORANT rank roles')
    .setDescription(NOT_CONFIGURED_MESSAGE.detail)
    .setFooter({ text: 'The bot is running without a rank API key, so no lookup can be made.' });

  return {
    embeds: [embed],
    components: [createRolesRow()],
    flags: MessageFlags.Ephemeral,
  };
}

function unlinkedView(): MenuView {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('VALORANT rank roles')
    .setDescription(
      'Link your Riot ID once and this menu keeps your competitive rank role up to date. ' +
        'You never have to type a command with arguments again.',
    )
    .addFields(
      {
        name: '1. Link',
        value: 'Press **Link account** and paste your Riot ID, for example `SomePlayer#EU1`.',
        inline: false,
      },
      {
        name: '2. Region',
        value: 'Your region is worked out from the tag. You never pick one.',
        inline: false,
      },
      {
        name: '3. Done',
        value: 'Your rank role is applied immediately, and refreshed from here whenever you want.',
        inline: false,
      },
    )
    .setFooter({ text: 'Linking is how you consent to the bot reading your rank. Unlink at any time.' });

  return {
    embeds: [embed],
    components: [
      primaryRow((button) => button.setCustomId(MENU_BUTTONS.link).setLabel('Link account')),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

function linkedWithoutRankView(account: LinkedAccount): MenuView {
  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle('VALORANT rank roles')
    .setDescription(`Linked account: **${account.name}#${account.tag}**`)
    .addFields({
      name: 'Rank',
      value: 'Not read yet. Press **Refresh rank** to look it up.',
      inline: false,
    })
    .setFooter({ text: 'The provider caches rank responses for up to five minutes.' });

  return {
    embeds: [embed],
    components: [createRolesRow(), unlinkRow()],
    flags: MessageFlags.Ephemeral,
  };
}

function linkedView(account: LinkedAccount, snapshot: RankSnapshot): MenuView {
  const embed = new EmbedBuilder()
    .setColor(snapshot.tier?.color ?? MUTED)
    .setTitle('VALORANT rank roles')
    .setDescription(`Linked account: **${account.name}#${account.tag}**`)
    .addFields(
      { name: 'Rank', value: snapshot.tierName, inline: true },
      { name: 'Rank rating', value: formatNumber(snapshot.rankRating), inline: true },
      { name: 'Estimated Elo', value: formatNumber(snapshot.estimatedElo), inline: true },
      { name: 'Region', value: snapshot.affinity.toUpperCase(), inline: true },
      { name: 'Platform', value: snapshot.platform, inline: true },
      { name: 'Placements left', value: formatNumber(snapshot.gamesNeededForRating), inline: true },
    )
    .setFooter({
      text: 'The provider caches responses for five minutes, so a fresh promotion can take a moment to show.',
    });

  if (snapshot.tier === null) {
    embed.addFields({
      name: 'No role for this rank',
      value: 'This rank is not in the role catalog, so no role was applied. The name above is still correct.',
      inline: false,
    });
  }
  if (snapshot.inferredAffinity !== null && snapshot.inferredAffinity !== snapshot.affinity) {
    embed.addFields({
      name: 'Heads up',
      value:
        `Your tag suggested \`${snapshot.inferredAffinity.toUpperCase()}\` but the account resolved in ` +
        `\`${snapshot.affinity.toUpperCase()}\`. The lookup worked; your rank role is correct.`,
      inline: false,
    });
  }

  return {
    embeds: [embed],
    components: [
      primaryRow((button) => button.setCustomId(MENU_BUTTONS.refresh).setLabel('Refresh rank')),
      unlinkRow(),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function primaryRow(build: (button: ButtonBuilder) => ButtonBuilder): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    build(new ButtonBuilder().setStyle(ButtonStyle.Primary)),
  );
}

/**
 * The unlink row is secondary on purpose: it destroys the stored link, so it must not look like
 * the button a member is most likely to press.
 */
function unlinkRow(): ActionRowBuilder<ButtonBuilder> {
  return primaryRow(
    (button) => button.setCustomId(MENU_BUTTONS.unlink).setLabel('Unlink').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * The operator action, kept on its own row so it reads as the admin control it is and so
 * `interaction.ts` has exactly one thing to gate.
 */
function createRolesRow(): ActionRowBuilder<ButtonBuilder> {
  return primaryRow(
    (button) => button.setCustomId(MENU_BUTTONS.createRoles).setLabel('Create rank roles'),
  );
}
