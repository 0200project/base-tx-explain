import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ledger now carries risk-check rollups alongside demand and revenue. These
 * exercise the replay path against a real file, because that is where the two
 * kinds of event can corrupt each other.
 *
 * Modules are imported dynamically after DATA_DIR is stubbed: usage.ts resolves
 * the ledger path at module load, and both modules must come from the same fresh
 * registry so they share one in-memory state.
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'btx-ledger-'));
  vi.stubEnv('DATA_DIR', dir);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const hourAgo = (): string => new Date(Date.now() - 3_600_000).toISOString().slice(0, 13);

async function load() {
  const usage = await import('../src/usage.js');
  const health = await import('../src/checkHealth.js');
  return { usage, health };
}

describe('usage ledger replay with check-health rollups', () => {
  it('rebuilds demand, revenue and check availability from one file', async () => {
    const hour = hourAgo();
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ t: '2026-08-20T17:45:29.000Z', e: 'call', charge: false, client: 'aaaa1111' }),
        JSON.stringify({ t: '2026-08-20T17:46:00.000Z', e: 'settled', client: 'payer', amount_usd: 0.02 }),
        JSON.stringify({
          t: '2026-08-20T22:20:00.000Z',
          e: 'checks',
          hour,
          counts: { first_interaction: { unavailable: 6 }, contract_verification: { ok: 6 }, drainer_blacklist: { ok: 6 } },
        }),
        '{ torn write, no closing brace',
      ].join('\n') + '\n',
    );

    const { usage, health } = await load();
    usage.initUsageLedger();

    const snap = usage.usageSnapshot(1) as { lifetime: { calls: number; settlements: number; revenue_usd: number } };
    expect(snap.lifetime.calls).toBe(1);
    expect(snap.lifetime.settlements).toBe(1);
    expect(snap.lifetime.revenue_usd).toBe(0.02);

    const first = health.checkHealthSnapshot(24).checks.first_interaction;
    expect(first.unavailable).toBe(6);
    expect(first.dark_hours).toBe(1);
    expect(health.checkHealthSnapshot(24).checks.contract_verification.ok).toBe(6);
  });

  it('does not book an unrecognised event as a settlement', async () => {
    // A rollback to a build that predates an event type must lose the reading,
    // never silently convert it into revenue.
    writeFileSync(
      join(dir, 'events.jsonl'),
      [
        JSON.stringify({ t: '2026-08-20T17:45:29.000Z', e: 'call', charge: false, client: 'aaaa1111' }),
        JSON.stringify({ t: '2026-08-20T17:47:00.000Z', e: 'something_added_later', client: 'x', amount_usd: 99 }),
      ].join('\n') + '\n',
    );

    const { usage } = await load();
    usage.initUsageLedger();

    const snap = usage.usageSnapshot(1) as { lifetime: { settlements: number; revenue_usd: number } };
    expect(snap.lifetime.settlements).toBe(0);
    expect(snap.lifetime.revenue_usd).toBe(0);
  });

  it('appends closed-hour rollups on flush, and survives a restart', async () => {
    const { usage, health } = await load();
    usage.initUsageLedger();

    const anHourAgo = new Date(Date.now() - 3_600_000);
    for (let i = 0; i < 3; i++) {
      health.recordChecks(
        {
          contract_verification: 'ok',
          first_interaction: 'unavailable',
          drainer_blacklist: 'ok',
          unchecked_addresses: [],
          note: null,
        },
        anHourAgo,
      );
    }
    usage.flushCheckHealth();

    const written = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(written).toHaveLength(1);
    const ev = JSON.parse(written[0] ?? '{}');
    expect(ev.e).toBe('checks');
    expect(ev.counts.first_interaction).toEqual({ unavailable: 3 });

    // Restart: a fresh registry replaying the same file sees the same outage.
    vi.resetModules();
    const restarted = await load();
    restarted.usage.initUsageLedger();
    const first = restarted.health.checkHealthSnapshot(24).checks.first_interaction;
    expect(first.unavailable).toBe(3);
    expect(first.dark_hours).toBe(1);
    // `first_event_at` means "when did anyone first call this" — a monitoring
    // rollup is not a call and must not become the answer.
    const snap = restarted.usage.usageSnapshot(1) as { first_event_at: string | null };
    expect(snap.first_event_at).toBeNull();
  });
});
