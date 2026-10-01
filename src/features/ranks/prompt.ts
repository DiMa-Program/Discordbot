/**
 * The one-time opt-in prompt, sent by direct message when a member joins.
 *
 * WHY A JOIN EVENT AT ALL, AND WHY IT IS NOT ENOUGH ON ITS OWN.
 *
 * `guildMemberAdd` is the one moment a member is guaranteed to be reachable without interrupting
 * anything, and it is the moment somebody is deciding whether this bot is part of their server
 * experience at all. But it is not a sync mechanism: it fires once, on join, and a member who climbs
 * from Diamond to Ascendant without leaving produces no event. The periodic pass in `sync.ts` is
 * what keeps ranks current; this is only how a member is asked, once.
 *
 * THE PROMPT ASKS; IT NEVER LOOKS UP. There is no provider call anywhere in this file, and that is
 * a compliance constraint rather than an omission. The provider's terms state that analytic services
 * where the user has not given consent are not supported, and Riot's policy forbids exposing a
 * player's data without opt-in. So the answer to "yes" is a MODAL, not a lookup: the member types
 * their own Riot ID, and that submission is the consent. Nothing in this file can read anybody's
 * rank, whoever they are.
 *
 * A FAILED DELIVERY IS NOT AN ANSWER. A member with direct messages closed produces Discord error
 * 50007. Recording that as a decline would permanently disqualify somebody for a privacy setting
 * they never chose in relation to this bot, and the fix has to be the opposite one: log it, leave
 * the decision unset, and ask again the next time they join — by which time they may have opened
 * their messages, and by which time they may have run `/menu` and linked an account, which also
 * stops the prompt. There is no channel fallback here on purpose: a public question about rank is
 * not consent, and the alternative was ruled out of scope for that reason.
 *
 * Requires the PRIVILEGED `GuildMembers` intent. `../index.ts` declares it so the registry warns at
 * boot when it is missing, and the README documents the Developer Portal toggle. The `welcome`
 * feature declares the same intent for its own handler; two features may declare one intent, and the
 * boot diagnostics list it once.
 */

import type { GuildMember } from 'discord.js';

import type { Logger } from '../../core/logger.js';
import { isRankProviderConfigured } from './context.js';
import { getPromptDecision, isLinked, type PromptDecision } from './store.js';
import { buildPromptView, PROMPT_BUTTONS } from './view.js';

/**
 * Everything this module knows about one member when the join event fires.
 *
 * Narrower than a `GuildMember` on purpose: the rules below are about a stored decision and a stored
 * link, and expressing them over this shape means they can be tested with no Discord object at all.
 */
export interface PromptCandidate {
  /** The answer already on record, or `null` when this member has never been asked. */
  readonly decision: PromptDecision | null;
  /** Whether a Riot ID is already linked, which is consent enough on its own. */
  readonly linked: boolean;
}

/**
 * Whether this member should be sent the prompt right now. Pure.
 *
 * TWO INDEPENDENT WAYS TO HAVE ANSWERED ALREADY, and both have to be checked. A stored decision is
 * the explicit answer, either way round: accepting is remembered even when the modal was abandoned.
 * A link is the implicit one, because a member who linked through `/menu` has already consented and
 * asking them again on a later join would be a second request for something they granted.
 *
 * Written as its own function because "never ask twice" is the single property the prompt handler
 * exists to guarantee, and it should be provable without sending a message.
 */
export function shouldPrompt(candidate: PromptCandidate): boolean {
  return candidate.decision === null && !candidate.linked;
}

/**
 * Reads what the store knows about one user and answers `shouldPrompt`.
 *
 * The seam between the two, so a caller cannot accidentally apply the rule to a stale decision.
 */
export function needsPrompt(userId: string): boolean {
  return shouldPrompt({ decision: getPromptDecision(userId), linked: isLinked(userId) });
}

/**
 * Sends the opt-in prompt to a member who has just joined.
 *
 * Every early return is a state the member is in, not an error path. The three of them — a bot, a
 * member who already answered, a bot with no API key — all end with nobody being asked.
 */
export async function handleGuildMemberAdd(member: GuildMember, log: Logger): Promise<void> {
  if (member.user.bot) {
    return;
  }

  // Asked only when a lookup could actually follow. Promising a rank role the bot has no key to
  // deliver would send somebody through a modal that ends in an explanation about a variable only the
  // operator can see.
  if (!isRankProviderConfigured()) {
    log.debug('HENRIK_DEV_API_KEY is not set: skipping the rank opt-in prompt');
    return;
  }

  if (!needsPrompt(member.id)) {
    return;
  }

  const view = buildPromptView();
  try {
    await member.user.send({ embeds: [...view.embeds], components: [...view.components] });
  } catch (error) {
    // Deliberately NOT recorded as a decline. See the module comment: a closed inbox must not be a
    // permanent answer, so the member stays undecided and is asked again on a later join.
    log.warn(
      { err: error, userId: member.id, guildId: member.guild.id },
      'could not deliver the rank opt-in prompt: direct messages are probably closed',
    );
    return;
  }

  log.info({ userId: member.id, guildId: member.guild.id }, 'sent the rank opt-in prompt');
}

/**
 * What a pressed button means, or `null` when it is not one of this feature's prompt buttons.
 *
 * A lookup rather than a branch at the call site, so an unknown id cannot fall through into an
 * answer by accident — the alternative is a `switch` whose `default` records something.
 */
export function promptDecisionForCustomId(customId: string): PromptDecision | null {
  switch (customId) {
    case PROMPT_BUTTONS.accept:
      return 'accepted';
    case PROMPT_BUTTONS.decline:
      return 'declined';
    default:
      return null;
  }
}