import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/openapi.js';

/**
 * `/explain`'s 402 said the x402 challenge is "in the PAYMENT-REQUIRED header
 * AND THE BODY". The body does not carry it: it has no `x402Version` and no
 * `accepts`, and is instead eleven human-readable strings. The challenge is in
 * the header only.
 *
 * Not a conformance break — but our pitch on this exact surface is "you cannot
 * check our credentials, you can check our work". A stranger comparing our
 * published description to our real response finds it wrong, and a verifier who
 * finds one undocumented difference stops checking and starts wondering.
 *
 * ⚠️ `/mcp`'s 402 is DIFFERENT and correct as written: MCP has no response
 * headers, so the challenge travels in-band and the body genuinely does carry
 * x402Version and accepts. Verified against the live endpoint. Do not
 * "consistency-fix" the two to match — they describe different transports, and
 * an earlier attempt at this change weakened the MCP schema using evidence
 * gathered from /explain.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = buildOpenApiDocument('0.1.4', '0.02', true, 'https://api.0200project.com') as any;

describe('the published 402 description matches the wire', () => {
  const explain = doc.paths['/explain'].post.responses['402'].description as string;

  it('does not claim the /explain body carries the challenge', () => {
    expect(explain).not.toMatch(/header and the body/i);
  });

  it('says the challenge is in the header', () => {
    expect(explain).toMatch(/PAYMENT-REQUIRED/);
  });

  it('names what the body actually contains, so the difference is documented rather than discovered', () => {
    for (const field of ['what_you_get', 'talk_to_us', 'buy_with_card', 'free_tier', 'openapi']) {
      expect(explain).toContain(field);
    }
  });

  it('keeps the MCP 402 schema intact — its body really does carry the challenge', () => {
    const mcp = doc.paths['/mcp'].post.responses['402'];
    const required = mcp.content['application/json'].schema.required;
    expect(required).toContain('x402Version');
    expect(required).toContain('accepts');
  });
});
