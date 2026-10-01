/**
 * Turning provider failures into something a member can act on.
 *
 * Kept apart from both the provider and the interaction handler for one reason: the mapping is
 * where a leak would happen, and it is the part most likely to grow. Every string here is written
 * to be pasted into a channel in front of a person, so none of them may contain an exception
 * message, a status body, a request URL or anything configured. An unexpected error becomes a
 * generic sentence plus a request id, and the detail goes to the log.
 */

import {
  AccountNotFoundError,
  AccountNotInShardError,
  InvalidRiotIdError,
  RankAuthError,
  RankNetworkError,
  RankProviderError,
  RankProviderNotConfiguredError,
  RankRateLimitedError,
  UnexpectedRankResponseError,
} from './provider.js';
import { AFFINITIES } from './regions.js';

/** A failure rendered for display. */
export interface RankFailure {
  /** First line: what went wrong. */
  readonly title: string;
  /** What the member can do about it. Empty when there is genuinely nothing they can do. */
  readonly detail: string;
  /**
   * True when the problem belongs to the operator rather than the member.
   *
   * Drives whether the message says "try again" or "ask an admin", and it is the reason a
   * rejected API key never reads as the member's mistake.
   */
  readonly operatorFault: boolean;
}

/**
 * The message shown when the bot has no API key.
 *
 * The member cannot fix this, so the text is addressed to whoever runs the bot and names the exact
 * variable rather than saying "ask an administrator".
 */
export const NOT_CONFIGURED_MESSAGE: RankFailure = {
  title: 'Rank lookups are not set up on this bot yet.',
  detail:
    'Someone who runs the bot has to add HENRIK_DEV_API_KEY to its .env file and restart it. Everything else in the bot keeps working meanwhile.',
  operatorFault: true,
};

/** The message shown when the lookup succeeded but its outcome is not the expected shape. */
export const UNEXPECTED_MESSAGE: RankFailure = {
  title: 'Something went wrong reading that rank.',
  detail: 'Nothing was changed. Try again in a few minutes.',
  operatorFault: false,
};

/** Wraps a failure as a Discord-safe string. `requestId` is an opaque handle for the log line. */
export function formatRankFailure(failure: RankFailure, requestId: string): string {
  const parts = [failure.detail === '' ? failure.title : `${failure.title}\n${failure.detail}`];
  parts.push(`Reference: \`${requestId}\``);
  return parts.join('\n');
}

/**
 * Maps a thrown value to a displayable failure.
 *
 * Anything unrecognised becomes `UNEXPECTED_MESSAGE` rather than its own text: a `TypeError` from
 * deep inside `fetch` has no business in a channel, and the request id is what ties the member's
 * report to the log.
 */
export function describeRankFailure(error: unknown): RankFailure {
  if (error instanceof RankProviderNotConfiguredError) {
    return NOT_CONFIGURED_MESSAGE;
  }
  if (error instanceof InvalidRiotIdError) {
    return {
      title: 'That is not a Riot ID.',
      detail: 'Use the form `Name#TAG`, exactly as it appears in game — for example `SomePlayer#EU1`.',
      operatorFault: false,
    };
  }
  if (error instanceof AccountNotFoundError) {
    return {
      title: 'No VALORANT account matched that Riot ID in any region.',
      detail:
        'Check the spelling of both halves, including the tag. The tag decides which region is ' +
        'searched, and a wrong tag is the usual cause.',
      operatorFault: false,
    };
  }
  if (error instanceof AccountNotInShardError) {
    return {
      title: 'That account is not in the region its tag points at.',
      detail:
        'Riot ID tags and regions do not always match for custom games. Try the default Riot ID ' +
        `shown in your VALORANT profile, or a tag from your competitive matches. Regions searched: ${AFFINITIES.join(', ')}.`,
      operatorFault: false,
    };
  }
  if (error instanceof RankRateLimitedError) {
    return {
      title: 'The rank service is rate limiting us right now.',
      detail: 'Wait about five minutes and press Refresh again.',
      operatorFault: false,
    };
  }
  if (error instanceof RankNetworkError) {
    return {
      title: 'Could not reach the rank service.',
      detail: 'Nothing was changed. Try again in a few minutes.',
      operatorFault: false,
    };
  }
  if (error instanceof RankAuthError) {
    return {
      title: 'The bot cannot use the rank service right now.',
      detail:
        'Its API key was rejected. Someone who runs the bot has to check HENRIK_DEV_API_KEY and restart it.',
      operatorFault: true,
    };
  }
  if (error instanceof UnexpectedRankResponseError) {
    return { ...UNEXPECTED_MESSAGE };
  }
  if (error instanceof RankProviderError) {
    // A family member this mapping does not know yet. Still generic, still safe to show.
    return { ...UNEXPECTED_MESSAGE };
  }
  return { ...UNEXPECTED_MESSAGE };
}
