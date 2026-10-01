/**
 * Tests for the one-time opt-in prompt.
 *
 * THE PROPERTY UNDER TEST IS "EXACTLY ONCE, AND NEVER A LOOKUP".
 *
 * Those are two different guarantees and both are load-bearing. "Exactly once" is a promise to a
 * human being: nobody wants a bot that asks the same question every time they join. "Never a lookup"
 * is a promise to the provider whose terms the whole feature is built to respect, and it is enforced
 * here by giving the handler a real configured provider and then asserting the provider was never
 * touched — not by reading the source and trusting it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../core/logger.js';
import { configureRankContext, resetRankContext } from './context.js';
import { handleGuildMemberAdd, promptDecisionForCustomId, shouldPrompt } from './prompt.js';
import {
  getPromptDecision,
  isLinked,
  linkAccount,
  recordPromptDecision,
  resetLinkedAccounts,
  resetPromptDecisions,
} from './store.js';
import { PROMPT_BUTTONS } from './view.js';

const USER = '111111111111111111';
const NOW = 1_700_000_000_000;

/* -------------------------------------------------------------------------------------------- */
/* Fakes                                                                                           */
/* -------------------------------------------------------------------------------------------- */

type Spy = ReturnType<typeof vi.fn>;

interface FakeLog {
  readonly log: Logger;
  readonly info: Spy;
  readonly warn: Spy;
  readonly error: Spy;
}

function makeLog(): FakeLog {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { log: { info, warn, error, debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() } as unknown as Logger, info, warn, error };
}

/**
 * A member, with a direct-message channel that can be made to fail the way Discord's does.
 *
 * `failSend` is the important half: a member with closed direct messages is the single most common
 * way this handler can fail, and the behaviour it must produce (stay undecided) is not something a
 * test can check by inspecting code.
 */
function fakeMember(options: { readonly bot?: boolean; readonly failSend?: boolean } = {}) {
  const send: Spy = vi.fn(async (_payload: unknown): Promise<void> => {
    if (options.failSend === true) {
      // Discord's own wording for this: "Cannot send messages to this user".
      throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    }
  });

  const member = {
    id: USER,
    guild: { id: 'guild-1' },
    user: { id: USER, bot: options.bot ?? false, send },
  };

  return { send, member };
}

/** The ids of the buttons a sent message carried, read out of the payload. */
function sentButtonIds(send: Spy): readonly string[] {
  // Round-tripped through JSON because the payload holds discord.js BUILDERS, whose readable shape
  // is private. This is what Discord receives over the wire, so it is also the right thing to assert
  // on: the member's button has to exist on the wire, not merely in memory.
  const payload = JSON.parse(JSON.stringify(send.mock.calls[0]?.[0] ?? null)) as {
    components?: ReadonlyArray<{ components?: ReadonlyArray<{ custom_id?: string }> }>;
  } | null;
  return (payload?.components ?? []).flatMap((row) => row.components ?? []).map((button) => button.custom_id ?? '');
}

beforeEach(() => {
  resetLinkedAccounts();
  resetPromptDecisions();
  resetRankContext();
});

afterEach(() => {
  resetRankContext();
});

/* -------------------------------------------------------------------------------------------- */
/* Tests                                                                                           */
/* -------------------------------------------------------------------------------------------- */

describe('shouldPrompt', () => {
  it('asks a member who has never been asked and has linked nothing', () => {
    expect(shouldPrompt({ decision: null, linked: false })).toBe(true);
  });

  it('never asks again after a decline', () => {
    expect(shouldPrompt({ decision: 'declined', linked: false })).toBe(false);
  });

  it('never asks again after an accept, even when the modal was abandoned', () => {
    // "Yes" with no link is the state a member reaches by closing the modal, and it must still count
    // as answered. Asking again would be a bot that does not listen.
    expect(shouldPrompt({ decision: 'accepted', linked: false })).toBe(false);
  });

  it('never asks a member who already linked, because that link was consent', () => {
    expect(shouldPrompt({ decision: null, linked: true })).toBe(false);
  });
});

describe('the join prompt', () => {
  it('sends one direct message with an accept and a decline button', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();
    const joining = fakeMember();

    await handleGuildMemberAdd(joining.member as never, log);

    expect(joining.send).toHaveBeenCalledTimes(1);
    // Both buttons, namespaced apart from the menu's own, so a press can never be ambiguous.
    expect(sentButtonIds(joining.send)).toEqual([PROMPT_BUTTONS.accept, PROMPT_BUTTONS.decline]);
    // And nothing was recorded: asking is not an answer, and recording one here would make the
    // prompt impossible to answer at all.
    expect(getPromptDecision(USER)).toBeNull();
  });

  it('does not touch the provider, because asking is not consent', async () => {
    const fetchImpl = vi.fn();
    configureRankContext({ readApiKey: () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    const { log } = makeLog();

    await handleGuildMemberAdd(fakeMember().member as never, log);

    // The provider's terms only allow a lookup for a member who agreed to one, and no agreement has
    // happened yet. This is the assertion that makes that claim checkable instead of aspirational.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not ask a member who already answered, whichever way they answered', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();

    for (const decision of ['accepted', 'declined'] as const) {
      recordPromptDecision(USER, decision, NOW);
      const joining = fakeMember();

      await handleGuildMemberAdd(joining.member as never, log);

      expect(joining.send).not.toHaveBeenCalled();
    }
  });

  it('does not ask a member who already linked an account', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    const joining = fakeMember();

    await handleGuildMemberAdd(joining.member as never, log);

    expect(isLinked(USER)).toBe(true);
    expect(joining.send).not.toHaveBeenCalled();
  });

  it('says nothing to another bot joining the server', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();
    const joining = fakeMember({ bot: true });

    await handleGuildMemberAdd(joining.member as never, log);

    expect(joining.send).not.toHaveBeenCalled();
  });

  it('stays silent when no API key is configured, rather than offering what it cannot deliver', async () => {
    configureRankContext({ readApiKey: () => undefined });
    const { log } = makeLog();
    const joining = fakeMember();

    await handleGuildMemberAdd(joining.member as never, log);

    expect(joining.send).not.toHaveBeenCalled();
    expect(getPromptDecision(USER)).toBeNull();
  });

  it('leaves a member with closed direct messages undecided, so they can still be asked', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log, warn } = makeLog();
    const blocked = fakeMember({ failSend: true });

    // No throw escapes: a gateway event handler that rejects takes the rejection with it.
    await expect(handleGuildMemberAdd(blocked.member as never, log)).resolves.toBeUndefined();

    // THE ASSERTION THAT MATTERS. Recording a decline here would permanently disqualify somebody
    // for a privacy setting they never chose in relation to this bot, and nothing would ever
    // correct it. The only remedy is to keep asking.
    expect(getPromptDecision(USER)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/direct messages/i);
  });

  it('asks again on a later join after a failed delivery, because the member is still undecided', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();

    await handleGuildMemberAdd(fakeMember({ failSend: true }).member as never, log);
    const later = fakeMember();
    await handleGuildMemberAdd(later.member as never, log);

    expect(later.send).toHaveBeenCalledTimes(1);
  });

  it('stops asking once a member links an account, even if no answer was ever recorded', async () => {
    configureRankContext({ readApiKey: () => 'test-key' });
    const { log } = makeLog();

    await handleGuildMemberAdd(fakeMember({ failSend: true }).member as never, log);
    linkAccount(USER, { name: 'Dipplox', tag: 'LPARG' }, NOW);
    const later = fakeMember();

    await handleGuildMemberAdd(later.member as never, log);

    expect(later.send).not.toHaveBeenCalled();
  });
});

describe('promptDecisionForCustomId', () => {
  it('maps both of the prompt buttons and nothing else', () => {
    expect(promptDecisionForCustomId(PROMPT_BUTTONS.accept)).toBe('accepted');
    expect(promptDecisionForCustomId(PROMPT_BUTTONS.decline)).toBe('declined');
    // Any other id, including the menu's own link button, is not an answer. Returning null instead of
    // a default is what stops an unknown id from falling through into a recorded decision.
    expect(promptDecisionForCustomId('rank:link')).toBeNull();
    expect(promptDecisionForCustomId('some-other-feature:button')).toBeNull();
  });
});