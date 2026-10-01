
/**
 * Tests for how the scheduler gets started.
 *
 * The scheduling arithmetic is covered in `sync.test.ts`. What matters here is the one thing that is
 * invisible in normal operation and cost an entire afternoon: whether the timer starts at all.
 *
 * A scheduler that never begins is indistinguishable at boot from one that was never requested. It
 * produces no error, no warning, and no log line, and the only symptom is that nothing happens twelve
 * hours later. Both orderings of the readiness event are therefore pinned down here, including the
 * one that silently did nothing in production.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { startRankSyncScheduler } from './sync.js';
import { configureRankContext, resetRankContext } from './context.js';

describe('startRankSyncScheduler', () => {
  /** The subset of the gateway client the scheduler touches. */
  interface FakeClient extends EventEmitter {
    isReady: () => boolean;
    guilds: { cache: Map<string, unknown> };
  }

  function fakeClient(ready: boolean): FakeClient {
    const client = new EventEmitter() as FakeClient;
    client.isReady = () => ready;
    client.guilds = { cache: new Map() };
    return client;
  }

  function silentLog(): { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void } {
    return { info: () => {}, warn: () => {}, debug: () => {} };
  }

  function useConfiguredKey(): void {
    configureRankContext({ readApiKey: () => 'test-key' });
  }

  it('starts the timer once clientReady fires', () => {
    useConfiguredKey();
    const client = fakeClient(false);
    let scheduled = 0;

    const stop = startRankSyncScheduler({
      client: client as never,
      intervalMs: 60_000,
      log: silentLog() as never,
      setIntervalImpl: () => {
        scheduled += 1;
        return 1;
      },
      clearIntervalImpl: () => {},
    });

    expect(scheduled).toBe(0);

    client.emit('clientReady');

    expect(scheduled).toBe(1);
    stop();
    resetRankContext();
  });

  it('starts immediately when the client is already ready', () => {
    // The ordering this covers actually happened: a `once` listener attached after the event has
    // fired is never called again, so the scheduler stayed inert for the whole process lifetime with
    // no error and no log line. Registering on an already-ready client has to work regardless.
    useConfiguredKey();
    const client = fakeClient(true);
    let scheduled = 0;

    startRankSyncScheduler({
      client: client as never,
      intervalMs: 60_000,
      log: silentLog() as never,
      setIntervalImpl: () => {
        scheduled += 1;
        return 1;
      },
      clearIntervalImpl: () => {},
    });

    expect(scheduled).toBe(1);
    resetRankContext();
  });

  it('does not schedule twice when the event arrives after registration', () => {
    useConfiguredKey();
    const client = fakeClient(false);
    let scheduled = 0;

    const stop = startRankSyncScheduler({
      client: client as never,
      intervalMs: 60_000,
      log: silentLog() as never,
      setIntervalImpl: () => {
        scheduled += 1;
        return 1;
      },
      clearIntervalImpl: () => {},
    });

    client.emit('clientReady');
    client.emit('clientReady');

    expect(scheduled).toBe(1);
    stop();
    resetRankContext();
  });

  it('does not schedule when the provider key is missing', () => {
    configureRankContext({ readApiKey: () => '' });
    const client = fakeClient(true);
    let scheduled = 0;

    startRankSyncScheduler({
      client: client as never,
      intervalMs: 60_000,
      log: silentLog() as never,
      setIntervalImpl: () => {
        scheduled += 1;
        return 1;
      },
      clearIntervalImpl: () => {},
    });

    expect(scheduled).toBe(0);
    resetRankContext();
  });

  it('cancels the timer on stop', () => {
    useConfiguredKey();
    const client = fakeClient(true);
    let cleared: unknown = null;

    const stop = startRankSyncScheduler({
      client: client as never,
      intervalMs: 60_000,
      log: silentLog() as never,
      setIntervalImpl: () => 7,
      clearIntervalImpl: (handle) => {
        cleared = handle;
      },
    });

    stop();

    expect(cleared).toBe(7);
    resetRankContext();
  });
});
