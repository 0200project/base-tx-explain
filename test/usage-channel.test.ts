import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * First-touch attribution in the ledger.
 *
 * The property under test is what the number MEANS, not that it increments.
 * Per-call attribution would rank listings by whichever sent the most talkative
 * visitor — one curious caller making forty calls outweighing forty separate
 * arrivals — and would answer a question nobody asked. The question is which
 * listing brought a stranger, so a stranger counts once, where they came in.
 */

async function load() {
  vi.resetModules();
  process.env.DATA_DIR = `/tmp/uch-${Math.random().toString(36).slice(2)}`;
  delete process.env.CHANNELS;
  return import('../src/usage.js');
}

type Call = { client: string; channel?: string; internal?: boolean };

function feed(m: Awaited<ReturnType<typeof load>>, calls: Call[]): void {
  let n = 0;
  for (const c of calls) {
    m.recordEvent({
      t: new Date(Date.UTC(2026, 7, 21, 12, 0, n++)).toISOString(),
      e: 'call',
      charge: false,
      client: c.client,
      ...(c.channel ? { channel: c.channel } : {}),
      ...(c.internal ? { internal: true } : {}),
    });
  }
}

function buckets(m: Awaited<ReturnType<typeof load>>): Record<string, { arrivals: number; calls: number }> {
  const snap = m.usageSnapshot() as { channels: { buckets: Record<string, { arrivals: number; calls: number }> } };
  return snap.channels.buckets;
}

describe('first-touch channel attribution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('counts a client once, against the channel it first arrived on', async () => {
    const m = await load();
    feed(m, [{ client: 'a', channel: 'glama' }]);
    expect(buckets(m).glama.arrivals).toBe(1);
  });

  it('does NOT re-attribute a client on later calls without a ref', async () => {
    // The case that makes first-touch necessary: an MCP client pastes the
    // listing URL once and subsequent calls may carry nothing. Re-attributing
    // would move a real arrival into `direct` and make every listing look dead.
    const m = await load();
    feed(m, [
      { client: 'a', channel: 'glama' },
      { client: 'a' },
      { client: 'a' },
    ]);
    const b = buckets(m);
    expect(b.glama.arrivals).toBe(1);
    expect(b.direct.arrivals).toBe(0);
    expect(b.glama.calls).toBe(1);
    expect(b.direct.calls).toBe(2);
  });

  it('does not let one talkative visitor outrank many arrivals', async () => {
    // The whole reason arrivals is the headline and calls is context.
    const m = await load();
    feed(m, [
      ...Array.from({ length: 40 }, () => ({ client: 'chatty', channel: 'apify' })),
      { client: 'p', channel: 'glama' },
      { client: 'q', channel: 'glama' },
      { client: 'r', channel: 'glama' },
    ]);
    const b = buckets(m);
    expect(b.apify.arrivals).toBe(1);
    expect(b.glama.arrivals).toBe(3);
    expect(b.apify.calls).toBe(40); // context, and visibly so
  });

  it('EXCLUDES our own marked traffic entirely', async () => {
    // Instance seven, pre-empted: counting our own calls would make testing
    // look like acquisition on the one number meant to prove acquisition.
    const m = await load();
    feed(m, [
      { client: 'us', channel: 'glama', internal: true },
      { client: 'them', channel: 'glama' },
    ]);
    const b = buckets(m);
    expect(b.glama.arrivals).toBe(1);
    expect(b.glama.calls).toBe(1);
  });

  it('gives an unattributed arrival its own bucket rather than a real channel', async () => {
    const m = await load();
    feed(m, [{ client: 'a' }, { client: 'b', channel: 'other' }]);
    const b = buckets(m);
    expect(b.direct.arrivals).toBe(1);
    expect(b.other.arrivals).toBe(1);
  });

  it('emits every allowlisted channel even at zero', async () => {
    // A listing that produced nothing must read as a zero, not be absent. A
    // missing row and a zero row look very different to whoever is deciding
    // whether to buy an eighth listing.
    const m = await load();
    feed(m, [{ client: 'a', channel: 'glama' }]);
    const b = buckets(m);
    expect(b.apify).toEqual({ arrivals: 0, calls: 0 });
    expect(b.direct).toBeDefined();
    expect(b.other).toBeDefined();
  });

  it('attributed clients reconcile against external client count', async () => {
    const m = await load();
    feed(m, [
      { client: 'a', channel: 'glama' },
      { client: 'b' },
      { client: 'c', channel: 'apify' },
      { client: 'us', internal: true },
    ]);
    const snap = m.usageSnapshot() as {
      channels: { external_clients_attributed: number };
      lifetime: { external_clients: number };
    };
    expect(snap.channels.external_clients_attributed).toBe(3);
    expect(snap.channels.external_clients_attributed).toBe(snap.lifetime.external_clients);
  });

  it('ships the self-reported caveat inside the object, not only in docs', async () => {
    const m = await load();
    const snap = m.usageSnapshot() as { channels: { self_reported: boolean; caveat: string } };
    expect(snap.channels.self_reported).toBe(true);
    expect(snap.channels.caveat).toMatch(/self-reported/i);
  });
});
