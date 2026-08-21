import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { isFirstInteraction } from '../src/risk/firstTime.js';

// The real module, with only the network stubbed — the point of these tests is
// the classification and its caching, which the risk-flags suite mocks away.

const COUNTERPARTY = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address;
const OTHER = '0x4200000000000000000000000000000000000006';

// The module-level cache is keyed by (sender, counterparty, block) and lives for
// the whole file, so every case uses a sender of its own.
let senderSeq = 0;
const freshSender = (): Address =>
  `0x${(++senderSeq).toString(16).padStart(40, '0')}` as Address;

const page = (entries: number, to: string) =>
  ({ status: '1', result: Array.from({ length: entries }, () => ({ to })) });

let fetchMock: ReturnType<typeof vi.fn>;

const respond = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: async () => body } as Response);

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Pin the fallback off, so the call counts below hold whether or not whoever
  // runs these has a key in their environment.
  vi.stubEnv('ETHERSCAN_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('isFirstInteraction — classification', () => {
  it('a full page is truncated, not an answer: the sender has more history than we read', async () => {
    // 1000 entries is the page cap. The counterparty is absent from every one of
    // them, which under a smaller history would read as `first` — the whole point
    // is that we cannot know, because the page ran out before the history did.
    fetchMock.mockReturnValueOnce(respond(page(1_000, OTHER)));
    expect(await isFirstInteraction(freshSender(), COUNTERPARTY, 1_000n)).toEqual({ kind: 'truncated' });
  });

  it('a short history with no prior transfer to the counterparty is `first`', async () => {
    fetchMock.mockReturnValueOnce(respond(page(999, OTHER)));
    expect(await isFirstInteraction(freshSender(), COUNTERPARTY, 1_000n)).toEqual({ kind: 'first' });
  });

  it('a prior transaction with the counterparty is `seen`, matched case-insensitively', async () => {
    fetchMock.mockReturnValueOnce(respond({ status: '1', result: [{ to: COUNTERPARTY.toUpperCase() }] }));
    expect(await isFirstInteraction(freshSender(), COUNTERPARTY, 1_000n)).toEqual({ kind: 'seen' });
  });

  it('an empty history is a real answer, not a failure', async () => {
    fetchMock.mockReturnValueOnce(respond({ status: '0', message: 'No transactions found', result: null }));
    expect(await isFirstInteraction(freshSender(), COUNTERPARTY, 1_000n)).toEqual({ kind: 'first' });
  });

  it('an upstream that will not answer is `unreachable`', async () => {
    fetchMock.mockReturnValueOnce(respond({ message: 'Too many requests' }, false));
    expect(await isFirstInteraction(freshSender(), COUNTERPARTY, 1_000n)).toEqual({ kind: 'unreachable' });
  });
});

describe('isFirstInteraction — what gets cached', () => {
  it('caches a truncated answer: the history before a mined block cannot change, so a re-read is waste', async () => {
    vi.useFakeTimers();
    const sender = freshSender();
    fetchMock.mockReturnValueOnce(respond(page(1_000, OTHER)));

    expect(await isFirstInteraction(sender, COUNTERPARTY, 1_000n)).toEqual({ kind: 'truncated' });
    vi.advanceTimersByTime(60 * 60 * 1000); // an hour, well past the negative TTL
    expect(await isFirstInteraction(sender, COUNTERPARTY, 1_000n)).toEqual({ kind: 'truncated' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not hold on to `unreachable`: a momentary outage must not answer for the rest of the day', async () => {
    vi.useFakeTimers();
    const sender = freshSender();
    fetchMock
      .mockReturnValueOnce(respond({}, false))
      .mockReturnValueOnce(respond(page(3, OTHER)));

    expect(await isFirstInteraction(sender, COUNTERPARTY, 1_000n)).toEqual({ kind: 'unreachable' });
    vi.advanceTimersByTime(11 * 60 * 1000); // past NEGATIVE_TTL
    expect(await isFirstInteraction(sender, COUNTERPARTY, 1_000n)).toEqual({ kind: 'first' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
