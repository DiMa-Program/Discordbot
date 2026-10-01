/**
 * The ranks feature's own `interactionCreate` listener, and the `/menu` and `/rank` command
 * handlers.
 *
 * WHY THIS LISTENER EXISTS ALONGSIDE THE CORE ROUTER.
 *
 * `applyRegistry` binds two kinds of listener: the command router from `core/registry.ts`, and every
 * handler a feature declares. The router answers chat-input commands and returns early for
 * everything else; this listener answers buttons and modal submissions and returns early for
 * chat-input. They are disjoint by construction — but this is the same shape of bug that once
 * shipped a command which was deployed and did nothing, so the disjointness is proven against the
 * real registry in `ranks.test.ts` rather than assumed here.
 *
 * THE FIRST STATEMENT IS A GUARD, NOT A PREFERENCE. `isChatInputCommand()` is evaluated before any
 * work, because a permission check or a guild check placed above it would run twice for every slash
 * command: once here, once in the real handler.
 *
 * EVERY FAILURE IS ANSWERED; NO FAILURE IS SWALLOWED. Each path replies on whichever of `reply` /
 * `editReply` is still legal, because an interaction that is never acknowledged reaches the user as
 * "The application did not respond" with no log line to debug it from. The one path that stays
 * quiet is an unrecognised custom id: answering that would fight a future version of this feature
 * for the same message.
 */

import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  Interaction,
  ModalSubmitInteraction,
} from 'discord.js';

import type { Logger } from '../../core/logger.js';
import { getRankProvider, isRankProviderConfigured } from './context.js';
import { describeRankFailure, formatRankFailure, NOT_CONFIGURED_MESSAGE } from './messages.js';
import { promptDecisionForCustomId } from './prompt.js';
import { parseRiotId, type RiotId } from './provider.js';
import type { RankSnapshot } from './provider.js';
import {
  applyRoleAssignment,
  createGuildRoleGateway,
  ensureRankRoles,
  planRoleRemoval,
  syncMemberRankRole,
  type RankRoleGateway,
  type RoleSyncBlocker,
} from './role-sync.js';
import {
  cacheRank,
  getCachedRank,
  getLinkedAccount,
  getPromptDecision,
  isRankCacheFresh,
  linkAccount,
  recordPromptDecision,
  unlinkAccount,
} from './store.js';
import type { LinkedAccount } from './store.js';
import { RANKS } from './tiers.js';
import {
  buildLinkModal,
  buildMenuView,
  buildRankView,
  LINK_MODAL_ID,
  MENU_BUTTONS,
  PROMPT_DECLINE_TEXT,
  RIOT_ID_FIELD,
  type MenuViewState,
  type RankSubject,
} from './view.js';

/* -------------------------------------------------------------------------------------------- */
/* Command                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * `/menu` — the single entry point, with no arguments by design.
 *
 * A command that takes arguments is a command that can be typed wrong, and this one exists so
 * nobody ever has to.
 */
export async function executeMenuCommand(
  interaction: ChatInputCommandInteraction,
  log: Logger,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This menu only works inside a server.', ephemeral: true });
    return;
  }
  if (!isRankProviderConfigured()) {
    // The menu itself is ephemeral, so the operator would never see this. The log is the only
    // place that says the feature is switched off, which is exactly what has to be debuggable.
    log.warn('HENRIK_DEV_API_KEY is not set: /menu will explain setup instead of looking up ranks');
    await interaction.reply({ ...buildMenuView({ kind: 'not-configured' }) });
    return;
  }

  const account = getLinkedAccount(interaction.user.id);
  const state: MenuViewState = account === null ? { kind: 'unlinked' } : { kind: 'linked', account, snapshot: null };
  await interaction.reply({ ...buildMenuView(state) });
}

/**
 * `/rank` — the rank of a member who has already linked an account.
 *
 * NO RIOT ID OPTION, AND THAT IS A COMPLIANCE CONSTRAINT RATHER THAN A DESIGN TASTE.
 *
 * The provider's terms state that analytic services where the user has not given consent are not
 * supported, and Riot's own policy forbids exposing a player's data without opt-in. Accepting a Riot
 * ID here would let anyone look up any player, which is precisely the bypass of the consent flow
 * the rest of this feature is built around — the link is the consent, and there is no second way in.
 * So the command takes a Discord user and nothing else, and a member with no link is answered
 * locally rather than looked up upstream.
 *
 * NO PERMISSION GATE, ON PURPOSE. Reading the rank of a member who linked is public within the
 * guild by design: linking already agreed to it, and a gate here would hide the command from
 * exactly the people who linked. It is a bot with no token and no history, so there is nothing to
 * gate.
 */
export async function executeRankCommand(
  interaction: ChatInputCommandInteraction,
  log: Logger,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: SERVER_ONLY_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!isRankProviderConfigured()) {
    // Same reasoning as `/menu`: the reply is ephemeral, so the log is the only place the operator
    // can see that the feature is switched off. The user-facing half reuses the shared message.
    log.warn('HENRIK_DEV_API_KEY is not set: /rank will explain setup instead of looking up ranks');
    await interaction.reply({ content: NOT_CONFIGURED_MESSAGE.detail, flags: MessageFlags.Ephemeral });
    return;
  }

  // No argument means the caller's own rank, so the two paths share every step after this line.
  const target = interaction.options.getUser('member') ?? interaction.user;
  const subject: RankSubject = target.id === interaction.user.id ? 'self' : 'other';

  const account = getLinkedAccount(target.id);
  if (account === null) {
    // Answered here, without touching the provider: a member who never linked has consented to
    // nothing, so there is nothing to ask about and nothing to reveal.
    await interaction.reply({
      content: notLinkedMessage(subject, target.id),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const resolved = await resolveRank(interaction, target.id, account, log);
  if (resolved === null) {
    return;
  }
  const view = buildRankView({
    subject,
    account,
    snapshot: resolved.snapshot,
    fetchedAt: resolved.fetchedAt,
    now: Date.now(),
    fromCache: resolved.fromCache,
  });

  // Discord allows exactly one acknowledgement, so which method is legal depends on whether the
  // lookup deferred. A cached answer never waited on the network, so it is still free to `reply`.
  if (resolved.acknowledged) {
    await interaction.editReply({ embeds: view.embeds });
    return;
  }
  await interaction.reply({ ...view });
}

/** A rank to display, the honest label for where it came from, and how to send it. */
interface ResolvedRank {
  readonly snapshot: RankSnapshot;
  readonly fetchedAt: number;
  readonly fromCache: boolean;
  /**
   * True when this function already deferred the interaction.
   *
   * Carried rather than left implicit because the answer has two delivery paths: a rank that was
   * already cached is answered with `reply`, and one that cost a request was answered with
   * `editReply` because it had to be deferred first.
   */
  readonly acknowledged: boolean;
}

/**
 * Serves the cached rank while it is inside the provider's window, and otherwise fetches a fresh one.
 *
 * THE CACHE IS THE POINT. The free tier allows 30 requests a minute and answers from a 300-second
 * cache, so a member re-running the command — the single most common thing anyone does with a rank
 * command — is served from memory and spends nothing. The cached answer is labelled as cached, so
 * spending no request is visible rather than a silent claim to be live.
 *
 * The target may be somebody other than the caller, and a stale cache for them is refreshed the
 * same way. That is correct rather than a leak: the refresh reads the account that member already
 * linked, which is exactly the read they consented to, and it is not broadcast — the reply is
 * ephemeral to the caller who asked.
 *
 * @returns `null` after answering a failure, so every caller reads as "the only difference between
 *          success and failure is that we already replied".
 */
async function resolveRank(
  interaction: ChatInputCommandInteraction,
  userId: string,
  account: LinkedAccount,
  log: Logger,
): Promise<ResolvedRank | null> {
  const cached = getCachedRank(userId);
  if (cached !== null && isRankCacheFresh(cached)) {
    return { snapshot: cached.snapshot, fetchedAt: cached.fetchedAt, fromCache: true, acknowledged: false };
  }

  // Deferred before the first network call: the free tier is slow enough that an unacknowledged
  // interaction would show "The application did not respond".
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const requestId = `rank-${interaction.id}`;
  try {
    const snapshot = await getRankProvider().fetchRank({ riotId: `${account.name}#${account.tag}` });
    // Written only on success, so a provider blip leaves the previous entry standing. The member
    // loses this reply but keeps a rank the bot already knew, and the next run can serve it.
    const stored = cacheRank(userId, snapshot);
    return { snapshot: stored.snapshot, fetchedAt: stored.fetchedAt, fromCache: false, acknowledged: true };
  } catch (error) {
    log.error({ err: error, requestId, userId, riotId: `${account.name}#${account.tag}` }, 'rank lookup failed');
    await interaction.editReply({ content: formatRankFailure(describeRankFailure(error), requestId) });
    return null;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Buttons and modals                                                                             */
/* -------------------------------------------------------------------------------------------- */

/** Interactions this feature owns, and the ones it can answer on. */
type RankComponentInteraction = ButtonInteraction | ModalSubmitInteraction;

/**
 * Buttons and modals. Everything else — chat input above all, which the core router owns — returns
 * immediately.
 */
export async function handleRankInteraction(interaction: Interaction, log: Logger): Promise<void> {
  if (interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.isButton()) {
    await guarded(interaction, log, (button) => handleButton(button, log));
    return;
  }
  if (interaction.isModalSubmit()) {
    await guarded(interaction, log, (modal) => handleModalSubmit(modal, log));
  }
}

/**
 * Runs a handler and turns anything it throws into a reply.
 *
 * A throwing handler that escapes would leave the interaction unacknowledged, which the user sees
 * as "The application did not respond" and the operator sees as nothing at all.
 */
async function guarded<T extends RankComponentInteraction>(
  interaction: T,
  log: Logger,
  run: (interaction: T) => Promise<void>,
): Promise<void> {
  try {
    await run(interaction);
  } catch (error) {
    await answerUnexpected(interaction, error, log);
  }
}

async function handleButton(interaction: ButtonInteraction, log: Logger): Promise<void> {
  // The join prompt's two buttons are answered here, on the same listener as the menu's, because a
  // feature declares each event once. They are a separate branch rather than extra menu buttons:
  // the prompt ids are namespaced apart from `MENU_BUTTONS`, so no press can be ambiguous.
  const promptDecision = promptDecisionForCustomId(interaction.customId);
  if (promptDecision !== null) {
    await handlePromptButton(interaction, promptDecision, log);
    return;
  }

  switch (interaction.customId) {
    case MENU_BUTTONS.link:
      await interaction.showModal(buildLinkModal());
      return;
    case MENU_BUTTONS.refresh:
      await handleRefresh(interaction, log);
      return;
    case MENU_BUTTONS.unlink:
      await handleUnlink(interaction, log);
      return;
    case MENU_BUTTONS.createRoles:
      await handleCreateRoles(interaction, log);
      return;
    default:
      log.warn({ customId: interaction.customId }, 'ignored a button that is not part of the ranks menu');
  }
}

/**
 * One press of one of the one-time prompt's buttons.
 *
 * THE ANSWER IS RECORDED BEFORE ANYTHING ELSE HAPPENS, for both buttons. Accepting does not store a
 * Riot ID — it opens the SAME modal `/menu` opens, and that submission is what the store treats as
 * consent — but it does record that the member was asked, so somebody who accepted and then closed
 * the modal is never ambushed by a second identical prompt on their next join.
 *
 * A press from somebody who is already decided is answered with the same end state rather than an
 * error: a button that outlived its question (an open DM, a client with the buttons cached) must not
 * be able to record a decision that contradicts one already on file.
 *
 * @param decision `'accepted'` opens the link modal; `'declined'` ends the conversation for good.
 */
async function handlePromptButton(
  interaction: ButtonInteraction,
  decision: 'accepted' | 'declined',
  log: Logger,
): Promise<void> {
  const alreadyDecided = getPromptDecision(interaction.user.id);
  if (alreadyDecided !== null && alreadyDecided !== decision) {
    log.info(
      { userId: interaction.user.id, recorded: alreadyDecided, pressed: decision },
      'ignored a repeated rank prompt answer',
    );
    await interaction.update({ content: PROMPT_DECLINE_TEXT, components: [] });
    return;
  }

  recordPromptDecision(interaction.user.id, decision);

  if (decision === 'accepted') {
    // The one modal, from the view layer: `LINK_MODAL_ID` and `RIOT_ID_FIELD` are identical to the
    // `/menu` path, so `handleModalSubmit` below is the only handler that can write a Riot ID.
    await interaction.showModal(buildLinkModal());
    return;
  }

  log.info({ userId: interaction.user.id }, 'rank opt-in declined; not asking again');
  // `update`, not `reply`: the buttons are replaced in place so the question cannot be answered
  // twice, and the member is not sent a second message in their own inbox.
  await interaction.update({ content: PROMPT_DECLINE_TEXT, components: [] });
}

async function handleRefresh(interaction: ButtonInteraction, log: Logger): Promise<void> {
  const account = getLinkedAccount(interaction.user.id);
  if (account === null) {
    await interaction.reply({ content: NOT_LINKED_MESSAGE, ephemeral: true });
    return;
  }
  const guild = guildOf(interaction);
  if (guild === null) {
    await interaction.reply({ content: SERVER_ONLY_MESSAGE, ephemeral: true });
    return;
  }

  // Deferred before the first network call: the free tier is slow enough that an unacknowledged
  // interaction would show "The application did not respond".
  await interaction.deferUpdate();
  const snapshot = await lookupRank(interaction, `${account.name}#${account.tag}`, log);
  if (snapshot === null) {
    return;
  }

  const note = await applyRankRole(guild, interaction.user.id, snapshot, log);
  // Cached here so the rank this refresh just paid for is what `/rank` answers from next, and so the
  // store holds every successful lookup rather than only the ones `/rank` happened to make itself.
  cacheRank(interaction.user.id, snapshot);
  await interaction.editReply({ ...buildMenuView({ kind: 'linked', account, snapshot }), ...note });
}

async function handleUnlink(interaction: ButtonInteraction, log: Logger): Promise<void> {
  const wasLinked = unlinkAccount(interaction.user.id);
  const guild = guildOf(interaction);
  const roleOutcome = guild === null ? 'No role needed removing.' : await clearRankRoles(interaction, guild, log);

  await interaction.reply({
    content: wasLinked
      ? // "Deleted", not "deleted from memory": the link lived in a database, and the member is
        // being told their Riot ID is gone from this bot rather than where the bytes happened to be.
        `Unlinked. Your Riot ID has been deleted. ${roleOutcome}`
      : 'Nothing was linked for you, so there was nothing to unlink.',
    ephemeral: true,
  });
}

async function handleCreateRoles(interaction: ButtonInteraction, log: Logger): Promise<void> {
  const guild = guildOf(interaction);
  if (guild === null) {
    await interaction.reply({ content: SERVER_ONLY_MESSAGE, ephemeral: true });
    return;
  }
  if (!canManageServer(interaction.memberPermissions)) {
    // Checked at runtime, not only through `default_member_permissions`: that field does not exist
    // for a button, and a cached permission list can be out of date either way.
    await interaction.reply({ content: MANAGE_SERVER_REQUIRED, ephemeral: true });
    return;
  }

  // Up to 26 REST calls, so the acknowledgement happens before the first one.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await ensureRankRoles(createGuildRoleGateway(guild));

  if (result.blockedBy !== null) {
    await interaction.editReply({ content: describeBlocker(result.blockedBy) });
    return;
  }

  log.info({ created: result.created.length, reused: result.skipped.length }, 'rank roles reconciled');
  await interaction.editReply({ embeds: [buildRolesEmbed(result.created.length, result.skipped.length)] });
}

async function handleModalSubmit(interaction: ModalSubmitInteraction, log: Logger): Promise<void> {
  if (interaction.customId !== LINK_MODAL_ID) {
    log.warn({ customId: interaction.customId }, 'ignored a modal submit that is not the link modal');
    return;
  }
  const guild = guildOf(interaction);
  if (guild === null) {
    await interaction.reply({ content: SERVER_ONLY_MESSAGE, ephemeral: true });
    return;
  }

  // Deferring before the key check as well: a modal submit that is not acknowledged within three
  // seconds is dismissed with no explanation.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!isRankProviderConfigured()) {
    await interaction.editReply({ content: NOT_CONFIGURED_MESSAGE.detail });
    return;
  }

  // A malformed ID is rejected before any request is spent, and answered as the ordinary user
  // error it is: an ERROR log line for a typo is noise that trains operators to ignore the log.
  const raw = interaction.fields.getTextInputValue(RIOT_ID_FIELD);
  let riotId: RiotId;
  try {
    riotId = parseRiotId(raw);
  } catch (error) {
    log.debug({ requestId: `rank-${interaction.id}` }, 'rejected a malformed Riot ID from the link modal');
    await interaction.editReply({
      content: formatRankFailure(describeRankFailure(error), `rank-${interaction.id}`),
    });
    return;
  }

  const snapshot = await lookupRank(interaction, `${riotId.name}#${riotId.tag}`, log);
  if (snapshot === null) {
    return;
  }

  // Stored only after the lookup succeeded: consent is captured by this flow, and a Riot ID that
  // could not be verified is not worth remembering.
  const account = linkAccount(interaction.user.id, { name: riotId.name, tag: riotId.tag });
  // After the link, never before: `linkAccount` drops any rank cached for the previous Riot ID, and
  // the snapshot just read belongs to the account that link now names.
  cacheRank(interaction.user.id, snapshot);
  const note = await applyRankRole(guild, interaction.user.id, snapshot, log);
  await interaction.editReply({ ...buildMenuView({ kind: 'linked', account, snapshot }), ...note });
}

/* -------------------------------------------------------------------------------------------- */
/* Shared steps                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * Performs the lookup, answering the interaction with a mapped failure and returning `null` when it
 * did not succeed.
 *
 * Returns `null` instead of throwing so the callers read as "the only difference between success
 * and failure is that we already answered". The raw error goes to the log with a request id; the
 * channel gets text that was built for a human to read.
 */
async function lookupRank(
  interaction: RankComponentInteraction,
  riotId: string,
  log: Logger,
): Promise<RankSnapshot | null> {
  const requestId = `rank-${interaction.id}`;
  try {
    return await getRankProvider().fetchRank({ riotId });
  } catch (error) {
    log.error({ err: error, requestId, riotId }, 'rank lookup failed');
    await editOrFollowUp(interaction, formatRankFailure(describeRankFailure(error), requestId));
    return null;
  }
}

/** Extra fields to merge into a rank embed when the role could not be applied. */
interface RoleChangeNote {
  readonly content?: string;
}

/**
 * Applies the rank role and returns a note when something got in the way.
 *
 * Silent on the clean path, because "your role was applied" on every successful refresh is noise,
 * and "I could not do this" is not.
 *
 * Delegated to `syncMemberRankRole`, which is the same routine the automatic pass uses. That is the
 * whole reason it is not written out again here: two copies of "read what they hold, plan, apply"
 * would be free to disagree, and disagreeing about which stale role gets removed is how a member ends
 * up wearing two rank roles and seeing the wrong colour with nothing in any log.
 */
async function applyRankRole(
  guild: Guild,
  userId: string,
  snapshot: RankSnapshot,
  log: Logger,
): Promise<RoleChangeNote> {
  const outcome = await syncMemberRankRole(createGuildRoleGateway(guild), snapshot.tier, userId);

  if (outcome.outcome === 'member-unreadable') {
    // The plan cannot be built without knowing what the member already holds: granting blind would
    // leave two rank roles on them, and Discord would render the higher one.
    log.warn({ userId }, 'could not read the member roles; skipping the rank role change');
    return { content: COULD_NOT_READ_ROLES };
  }
  if (outcome.blockedBy !== null) {
    log.warn({ blockedBy: outcome.blockedBy, userId }, 'rank role sync refused');
    return { content: describeBlocker(outcome.blockedBy) };
  }
  if (!outcome.applied) {
    return { content: NO_ROLE_FOR_RANK };
  }
  return {};
}

/** Removes every rank role the member holds. Used by the unlink path. */
async function clearRankRoles(interaction: ButtonInteraction, guild: Guild, log: Logger): Promise<string> {
  const gateway = createGuildRoleGateway(guild);
  const held = await readMemberRoleIds(gateway, interaction.user.id, log);
  if (held === null) {
    return COULD_NOT_READ_ROLES;
  }

  const plan = planRoleRemoval({
    tiers: RANKS,
    guildRoles: await gateway.listRankRoles(),
    memberRoleIds: held,
    canManageRoles: gateway.canManageRoles,
  });

  if (plan.blockedBy !== null) {
    return describeBlocker(plan.blockedBy);
  }
  const result = await applyRoleAssignment(gateway, plan, interaction.user.id);
  return result.removedRoleIds.length === 0 ? 'No rank role needed removing.' : 'Your rank role was removed.';
}

/**
 * The member's current roles, or `null` when they could not be read.
 *
 * `null` is a refusal, not an empty list. A member who left the server, or a cache miss on a role
 * read, must not be treated as holding nothing: doing so would make the sync grant the new role
 * without removing the old one.
 */
async function readMemberRoleIds(
  gateway: RankRoleGateway,
  userId: string,
  log: Logger,
): Promise<readonly string[] | null> {
  try {
    return await gateway.getMemberRoleIds(userId);
  } catch (error) {
    log.warn({ err: error, userId }, 'could not read the member roles; skipping the rank role change');
    return null;
  }
}

/* -------------------------------------------------------------------------------------------- */
/* Messages                                                                                       */
/* -------------------------------------------------------------------------------------------- */

const SERVER_ONLY_MESSAGE = 'Rank roles only exist inside a server.';

const MANAGE_SERVER_REQUIRED =
  'You need the Manage Server permission to create the rank roles. Ask a server admin to run it.';

const NOT_LINKED_MESSAGE = 'You have not linked a Riot ID yet. Run `/menu` and press **Link account** first.';

/**
 * The unlinked answer, worded for whoever is being told.
 *
 * Two phrasings rather than one because "you" would be wrong when the caller asked about somebody
 * else. The third-party version says only that no link exists and how to make one: it reveals nothing
 * about any account, which is the property that matters here — the whole point of the link is that
 * an account is private until its owner agrees to it.
 */
function notLinkedMessage(subject: RankSubject, userId: string): string {
  if (subject === 'self') {
    return NOT_LINKED_MESSAGE;
  }
  return (
    `<@${userId}> has not linked a VALORANT account to this bot, so there is no rank to show. ` +
    'They can link one from `/menu`, and only then can anyone ask.'
  );
}

const NO_ROLE_FOR_RANK =
  'Your rank is shown above, but this server has no role for it yet. Someone with **Manage Server** can press **Create rank roles** in `/menu`.';

const COULD_NOT_READ_ROLES =
  'Your rank is shown above, but no role was applied: the bot could not read your current roles. Try again in a moment.';

/**
 * The message for each way a role change can be refused.
 *
 * Every one of these is a configuration fact the reader can act on, which is the whole point: a
 * raw Discord 403 says "Missing Permissions" and nothing about which permission, on which object,
 * or in which direction the hierarchy is wrong.
 */
export function describeBlocker(blocker: RoleSyncBlocker): string {
  switch (blocker) {
    case 'missing-permission':
      return (
        'The bot cannot manage roles in this server, so no role was applied. Someone who runs ' +
        'the bot has to grant it **Manage Roles** (Server Settings → Roles → the bot → ' +
        'Permissions). You can re-run this from `/menu` afterwards.'
      );
    case 'role-hierarchy':
      return (
        'The rank role sits above the bot’s own role, so Discord will not let the bot assign it. ' +
        'Move the bot’s role higher in Server Settings → Roles, then re-run this from `/menu`. ' +
        'Your rank is unchanged.'
      );
    case 'role-not-created':
      return NO_ROLE_FOR_RANK;
  }
}

function canManageServer(permissions: { has(bit: bigint): boolean } | null): boolean {
  return permissions?.has(PermissionFlagsBits.ManageGuild) === true;
}

/**
 * The guild, or `null` in a direct message.
 *
 * `inGuild()` does not narrow the `guild` property for TypeScript, and a non-null assertion here
 * would be a lie the compiler cannot check — so the null travels with the value and every caller
 * decides what to say about it.
 */
function guildOf(interaction: RankComponentInteraction): Guild | null {
  return interaction.inGuild() ? interaction.guild : null;
}

function buildRolesEmbed(created: number, reused: number) {
  const embed = new EmbedBuilder()
    .setColor(0x6ae2af)
    .setTitle('Rank roles')
    .setDescription(
      created === 0
        ? 'Every rank role already existed. Nothing was changed.'
        : `Created ${created} role${created === 1 ? '' : 's'}. ${reused} already existed and were left untouched.`,
    )
    .setFooter({
      text: 'Members pick their rank with /menu. Role icons need Server Boost level 2, so plain colours are used.',
    });
  return embed;
}

/* -------------------------------------------------------------------------------------------- */
/* Failure acknowledgement                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * Answers on whichever channel is still open.
 *
 * Forced by Discord's one-acknowledgement rule: a path that deferred must `editReply`, a path that
 * has replied nothing must `reply`, and a path that has already replied must `followUp`. Getting
 * this wrong is what produces a silent "The application did not respond".
 */
async function answerUnexpected(interaction: RankComponentInteraction, error: unknown, log: Logger): Promise<void> {
  const requestId = `rank-${interaction.id}`;
  log.error({ err: error, requestId }, 'ranks interaction failed unexpectedly');
  const content = formatRankFailure(describeRankFailure(error), requestId);

  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

/** Reaches the response channel of a component interaction regardless of how far it got. */
async function editOrFollowUp(interaction: RankComponentInteraction, content: string): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content });
    return;
  }
  if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}
