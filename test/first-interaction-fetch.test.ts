import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { isFirstInteraction } from '../src/risk/firstTime.js';

// Exercises the REAL Blockscout fetch path (not the mock used by risk-flags),
// pinning the resilience behaviour: transient failures retry and recover, a real
// answer is never retried, and exhausted retries report `unreachable` — the
// distinction the check_health gauge and the whole fail-open contract depend on.

const SENDER = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;

// A fresh counterparty per test so the module-level cache never serves a stale
// verdict from a previous case.
let n = 0;
const freshCounterparty = (): Address =>
  (`0x${(++n).toString(16).padStart(40, '0')}`) as Address;

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const okArray = (txs: Array<{ to?: string }>) => res(200, { result: txs });
const okEmpty = () => res(200, { status: '0', message: 'No transactions found' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.ETHERSCAN_API_KEY; // keep the keyed fallback inert
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isFirstInteraction resilience', () => {
  it('retries a transient 429 and returns the recovered answer', async () => {
    const cp = freshCounterparty();
    fetchMock
      .mockResolvedValueOnce(res(429, {})) // rate-limited once
      .mockResolvedValueOnce(okArray([])); // then a clean empty history
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'first' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // proved it retried
  });

  it('retries a transient 500 and reports `seen` when the counterparty is found', async () => {
    const cp = freshCounterparty();
    fetchMock
      .mockResolvedValueOnce(res(500, {}))
      .mockResolvedValueOnce(okArray([{ to: cp.toLowerCase() }]));
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'seen' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a real (empty) answer', async () => {
    const cp = freshCounterparty();
    fetchMock.mockResolvedValueOnce(okEmpty());
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'first' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // a real answer is final
  });

  it('does NOT retry a permanent 4xx (other than 429)', async () => {
    const cp = freshCounterparty();
    fetchMock.mockResolvedValue(res(400, {})); // bad request: retrying cannot help
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'unreachable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports `unreachable` after exhausting retries on persistent transient failure', async () => {
    const cp = freshCounterparty();
    fetchMock.mockResolvedValue(res(503, {})); // always down
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'unreachable' });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2); // it tried more than once
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3); // but stayed bounded
  });

  it('reports `unreachable` on a network error, retried and bounded', async () => {
    const cp = freshCounterparty();
    fetchMock.mockRejectedValue(new Error('network down'));
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'unreachable' });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a >= PAGE_CAP history as `truncated`, not a verdict', async () => {
    const cp = freshCounterparty();
    const huge = Array.from({ length: 1000 }, () => ({ to: OTHER.toLowerCase() }));
    fetchMock.mockResolvedValueOnce(okArray(huge));
    const r = await isFirstInteraction(SENDER, cp, 100n);
    expect(r).toEqual({ kind: 'truncated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
