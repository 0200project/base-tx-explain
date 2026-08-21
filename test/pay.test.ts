import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Tests for client/pay.js, the browser-side x402 payment module.
 *
 * This is money code that no other test touches: it runs in someone else's
 * browser, against their wallet, and its output authorizes a real USDC
 * transfer. The failure mode that matters is silent — a signature that looks
 * fine and is rejected at settlement, after the payer has already approved it.
 *
 * So the load-bearing assertion is signature recovery. A wrong EIP-712 domain,
 * a reordered struct field or a mistyped field all produce a well-formed
 * signature over the WRONG type hash, which recovers to a different address and
 * which the token contract will refuse. Recovering to the signing account is
 * what proves the construction is right.
 *
 * pay.js is a browser IIFE assigning to `window`, not a module, so it is
 * evaluated with an injected window rather than imported.
 */

const PAY_JS = readFileSync(join(__dirname, '..', 'client', 'pay.js'), 'utf8');

// A well-known Hardhat test key. Nothing has ever held value here, and nothing
// in this file touches a real network.
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** The exact challenge production returned, captured live rather than invented. */
const CHALLENGE = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '20000',
      asset: USDC,
      payTo: '0xd4ec730ab062f20460727710fce70664948a6bc9',
      maxTimeoutSeconds: 300,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

interface PayResult {
  payer: string;
  payment: {
    x402Version: number;
    accepted: Record<string, unknown>;
    payload: { signature: Hex; authorization: Authorization };
  };
}

interface X402Pay {
  available(): boolean;
  challengeFrom(mcp: unknown): unknown;
  inspect(challenge: unknown): Promise<{
    canPay: boolean;
    heldDisplay: string;
    requiredDisplay: string;
    account: string;
  }>;
  payChallenge(challenge: unknown, options?: { onState?: (s: string) => void }): Promise<PayResult>;
  formatUnits(raw: string, decimals: number): string;
}

type Handler = (params?: unknown[]) => unknown;

/** A wallet stand-in. Overrides let each test break exactly one thing. */
function mockWallet(overrides: Record<string, Handler> = {}, balance = 10_000_000n) {
  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (overrides[method]) return overrides[method](params);
      if (method === 'eth_requestAccounts') return [account.address];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_call') return `0x${balance.toString(16).padStart(64, '0')}`;
      if (method === 'eth_signTypedData_v4') {
        const td = JSON.parse((params as string[])[1]);
        const { EIP712Domain: _domain, ...types } = td.types;
        return account.signTypedData({
          domain: td.domain,
          types,
          primaryType: td.primaryType,
          message: td.message,
        });
      }
      throw new Error(`unexpected wallet call: ${method}`);
    },
  };
}

function load(wallet: unknown): X402Pay {
  const win: Record<string, unknown> = { ethereum: wallet };
  new Function('window', 'crypto', PAY_JS)(win, globalThis.crypto);
  return win.x402Pay as X402Pay;
}

/** Assert a failure surfaces as a specific code, not a generic error. */
async function codeFor(pay: X402Pay, challenge: unknown): Promise<string> {
  try {
    await pay.payChallenge(challenge);
    return 'NO_ERROR_THROWN';
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
}

let pay: X402Pay;
beforeEach(() => {
  pay = load(mockWallet());
});

describe('pay.js — signature construction', () => {
  it('produces a signature that recovers to the signing account', async () => {
    // The whole point. A wrong domain or reordered struct field still yields a
    // syntactically valid signature; only recovery proves it signs the right thing.
    const res = await pay.payChallenge(CHALLENGE);
    const a = res.payment.payload.authorization;

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      types: TRANSFER_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as Hex,
        to: a.to as Hex,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: res.payment.payload.signature,
    });

    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('emits exactly the ExactEIP3009Payload shape the facilitator verifies', async () => {
    const res = await pay.payChallenge(CHALLENGE);
    expect(Object.keys(res.payment.payload.authorization).sort()).toEqual([
      'from',
      'nonce',
      'to',
      'validAfter',
      'validBefore',
      'value',
    ]);
    // `salt` belongs to the auth-capture scheme, not `exact`. Including it here
    // would be copying the wrong envelope out of the x402 types.
    expect(res.payment.payload).not.toHaveProperty('salt');
    expect(res.payment.x402Version).toBe(2);
  });

  it('takes every payment term from the challenge rather than inventing one', async () => {
    const res = await pay.payChallenge(CHALLENGE);
    const a = res.payment.payload.authorization;
    expect(a.value).toBe('20000');
    expect(a.to.toLowerCase()).toBe(CHALLENGE.accepts[0].payTo.toLowerCase());
    expect(a.from.toLowerCase()).toBe(account.address.toLowerCase());
    expect(a.validAfter).toBe('0');
    expect(Number(a.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('never repeats a nonce', async () => {
    // A reused nonce is a replay: the token rejects the second authorization,
    // so a payer whose first call succeeded would see the next one fail.
    const [a, b] = [await pay.payChallenge(CHALLENGE), await pay.payChallenge(CHALLENGE)];
    expect(a.payment.payload.authorization.nonce).not.toBe(b.payment.payload.authorization.nonce);
    expect(a.payment.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('pay.js — refuses to sign a challenge it cannot verify', () => {
  it('rejects a missing signing domain rather than guessing it', async () => {
    // Guessing the EIP-712 domain yields a signature the token silently refuses.
    const bad = { x402Version: 2, accepts: [{ ...CHALLENGE.accepts[0], extra: undefined }] };
    expect(await codeFor(pay, bad)).toBe('BAD_CHALLENGE');
  });

  it('rejects a non-positive amount', async () => {
    const bad = { x402Version: 2, accepts: [{ ...CHALLENGE.accepts[0], amount: '0' }] };
    expect(await codeFor(pay, bad)).toBe('BAD_CHALLENGE');
  });

  it('rejects a malformed recipient', async () => {
    const bad = { x402Version: 2, accepts: [{ ...CHALLENGE.accepts[0], payTo: '0xnope' }] };
    expect(await codeFor(pay, bad)).toBe('BAD_CHALLENGE');
  });

  it('declines a scheme or chain it does not implement', async () => {
    const other = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'solana:x', amount: '1' }] };
    expect(await codeFor(pay, other)).toBe('UNSUPPORTED');
  });
});

describe('pay.js — failure states stay distinguishable', () => {
  it('reports a declined signature as REJECTED, not as an error', async () => {
    const wallet = mockWallet({
      eth_signTypedData_v4: () => {
        throw Object.assign(new Error('User denied'), { code: 4001 });
      },
    });
    expect(await codeFor(load(wallet), CHALLENGE)).toBe('REJECTED');
  });

  it('reports an empty wallet as INSUFFICIENT_FUNDS before settlement can fail', async () => {
    expect(await codeFor(load(mockWallet({}, 0n)), CHALLENGE)).toBe('INSUFFICIENT_FUNDS');
  });

  it('reports a declined network switch as WRONG_NETWORK', async () => {
    const wallet = mockWallet({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        throw Object.assign(new Error('User denied'), { code: 4001 });
      },
    });
    expect(await codeFor(load(wallet), CHALLENGE)).toBe('WRONG_NETWORK');
  });

  it('switches to Base and continues when the wallet allows it', async () => {
    let switched = false;
    const wallet = mockWallet({
      eth_chainId: () => (switched ? '0x2105' : '0x1'),
      wallet_switchEthereumChain: () => {
        switched = true;
        return null;
      },
    });
    const res = await load(wallet).payChallenge(CHALLENGE);
    expect(switched).toBe(true);
    expect(res.payment.payload.signature).toBeTruthy();
  });
});

describe('pay.js — inspect gates the button without signing', () => {
  it('never asks for a signature', async () => {
    // EIP-3009 will sign an authorization for money the payer does not have;
    // the shortfall only appears at settlement. inspect() exists so the page can
    // decline to offer a payment that cannot succeed.
    let signCalls = 0;
    const wallet = mockWallet({ eth_signTypedData_v4: () => { signCalls++; return '0x00'; } }, 5_000n);
    const state = await load(wallet).inspect(CHALLENGE);
    expect(signCalls).toBe(0);
    expect(state.canPay).toBe(false);
  });

  it('reports what the wallet holds and what is needed, both human-readable', async () => {
    const state = await load(mockWallet({}, 5_000n)).inspect(CHALLENGE);
    expect(state.heldDisplay).toBe('0.005');
    expect(state.requiredDisplay).toBe('0.02');
  });

  it('confirms a funded wallet can pay', async () => {
    const state = await load(mockWallet({}, 10_000_000n)).inspect(CHALLENGE);
    expect(state.canPay).toBe(true);
  });
});

describe('pay.js — reading the challenge out of an MCP result', () => {
  it('finds a payment challenge in a tool result', () => {
    const mcp = { result: { content: [{ type: 'text', text: JSON.stringify(CHALLENGE) }] } };
    expect(pay.challengeFrom(mcp)).not.toBeNull();
  });

  it('returns null for a successful decode, so success is never mistaken for a paywall', () => {
    const ok = { result: { content: [{ text: '{"summary":"…","action_type":"swap"}' }] } };
    expect(pay.challengeFrom(ok)).toBeNull();
  });

  it('returns null rather than throwing on malformed content', () => {
    expect(pay.challengeFrom({ result: { content: [{ text: 'not json' }] } })).toBeNull();
    expect(pay.challengeFrom({})).toBeNull();
  });
});

describe('pay.js — amount formatting', () => {
  it('formats USDC atomic units for display', () => {
    expect(pay.formatUnits('20000', 6)).toBe('0.02');
    expect(pay.formatUnits('9000000', 6)).toBe('9');
    expect(pay.formatUnits('0', 6)).toBe('0');
    expect(pay.formatUnits('1234567', 6)).toBe('1.234567');
    expect(pay.formatUnits('1', 6)).toBe('0.000001');
  });
});
