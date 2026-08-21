import { describe, expect, it, vi } from 'vitest';

/**
 * The internal-traffic marker.
 *
 * Its entire value is the direction it fails in: forgetting the header must
 * make OUR call look external, never make a stranger's call look like ours.
 * Undercounting ourselves costs an investigation. Miscounting a stranger as
 * internal throws away the one signal this project is waiting for.
 *
 * The module reads its secret from the environment at import time, so each test
 * loads a fresh copy with the env it needs.
 */

async function load(marker: string | undefined) {
  const prev = process.env.INTERNAL_MARKER;
  if (marker === undefined) delete process.env.INTERNAL_MARKER;
  else process.env.INTERNAL_MARKER = marker;
  // The module reads its secret at import time, so drop the cache first.
  vi.resetModules();
  const mod = await import('../src/internal.js');
  if (prev === undefined) delete process.env.INTERNAL_MARKER;
  else process.env.INTERNAL_MARKER = prev;
  return mod as {
    isInternalRequest(h: Record<string, unknown>): boolean;
    internalMarkingEnabled(): boolean;
    INTERNAL_HEADER_NAME: string;
  };
}

const SECRET = 'a-long-unguessable-marker-value-9f3c1d';

describe('internal marker', () => {
  it('recognises our own traffic when the header matches', async () => {
    const m = await load(SECRET);
    expect(m.isInternalRequest({ 'x-btx-internal': SECRET })).toBe(true);
  });

  it('treats a call with no header as external', async () => {
    // The load-bearing case: this is what happens when we forget.
    const m = await load(SECRET);
    expect(m.isInternalRequest({})).toBe(false);
  });

  it('treats a wrong value as external rather than internal', async () => {
    // Someone probing the API and guessing the header name must not be
    // dismissed as one of us.
    const m = await load(SECRET);
    expect(m.isInternalRequest({ 'x-btx-internal': 'true' })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': '1' })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': 'internal' })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': SECRET + 'x' })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': SECRET.slice(0, -1) })).toBe(false);
  });

  it('marks nothing internal when no secret is configured', async () => {
    // Unset must not mean "match the empty string", which would make every
    // request carrying an empty header look like ours.
    const m = await load(undefined);
    expect(m.isInternalRequest({ 'x-btx-internal': '' })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': 'anything' })).toBe(false);
    expect(m.internalMarkingEnabled()).toBe(false);
  });

  it('ignores non-string header values without throwing', async () => {
    const m = await load(SECRET);
    expect(m.isInternalRequest({ 'x-btx-internal': ['a', 'b'] })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': undefined })).toBe(false);
    expect(m.isInternalRequest({ 'x-btx-internal': 42 })).toBe(false);
  });

  it('reports whether marking is configured, so a dashboard can say so', async () => {
    expect((await load(SECRET)).internalMarkingEnabled()).toBe(true);
    expect((await load(undefined)).internalMarkingEnabled()).toBe(false);
  });

  it('exposes the header NAME but never the value', async () => {
    // A marker an endpoint hands out is a marker anyone can wear.
    const m = await load(SECRET);
    expect(m.INTERNAL_HEADER_NAME).toBe('x-btx-internal');
    expect(JSON.stringify(m)).not.toContain(SECRET);
  });
});
