import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/openapi';

// WHY THIS EXISTS. The published spec carried `'0x' + 'ab'.repeat(32)` as the
// /explain example. That hash returns 404 not_found. openapi.json is the most
// machine-consumed artifact we publish -- codegen tools and agents run the
// example verbatim -- so the one call we handed them was a failing one, and
// "Transaction not found on Base mainnet" reads as a broken service rather than
// a fake input. Same class as llms.txt documenting a call that 402s.
//
// The example must be a REAL Base mainnet transaction (immutable, so it
// resolves permanently) and the SAME one every human-facing surface uses, so a
// machine and a person copying from different pages get identical behaviour.
const CANONICAL = '0x0c84b951051f779903b57af9225ca570c77cd5531195968dd78106a69d6c4d8c';

function example(): { tx_hash: string } {
  const doc = buildOpenApiDocument('0.1.4', '0.02', true, 'https://api.0200project.com') as any;
  return doc.paths['/explain'].post.requestBody.content['application/json'].example;
}

describe('openapi /explain example', () => {
  it('is the canonical hash, not a synthetic placeholder', () => {
    expect(example().tx_hash).toBe(CANONICAL);
  });

  it('contains no repeated-byte filler anywhere in the document', () => {
    // Catches 'ab'.repeat(32) and every sibling of it (0xdead..., 0x0000...).
    const doc = JSON.stringify(buildOpenApiDocument('0.1.4', '0.02', true, 'https://x'));
    const filler = doc.match(/0x(?:([0-9a-fA-F]{1,2})\1{20,})/g) ?? [];
    expect(filler).toEqual([]);
  });

  it('matches the hash the site publishes, so both paths behave identically', () => {
    const home = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
    expect(home).toContain(example().tx_hash);
  });
});
