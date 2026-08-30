import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits, type Address } from 'viem';
import { client } from './rpc.js';

/**
 * Watch what the company actually holds, and say when it falls.
 *
 * WHY BALANCE AND NOT TRANSACTION COUNT. The obvious monitor — "alert if the
 * wallet sends a transaction" — is blind on this rail by construction. Both
 * company wallets have a nonce of ZERO, and money has demonstrably moved in
 * both directions across them: $0.02 left the spend wallet and arrived at the
 * payout wallet, at block 50228190, with neither wallet ever having sent a
 * transaction. EIP-3009 lets the holder SIGN an authorisation while a
 * facilitator submits it and pays the gas, so the nonce never increments.
 *
 * A nonce-based monitor would therefore report all-clear on a wallet that had
 * been completely drained. That is worse than no monitor: it manufactures
 * confidence. Balance is the signal; transfers out are the corroboration.
 *
 * For the same reason, zero ETH is not a control either. It shapes a theft —
 * an attacker must submit from their own wallet — but it does not prevent one.
 *
 * SILENCE MUST NOT READ AS "NO CHANGE". If the RPC cannot be reached, that is
 * `unknown`, never `steady`. A monitor that reports calm when it is blind is
 * the same failure as a risk check that emits no flag when it could not run,
 * which this codebase already fixed once.
 */

/** Receives revenue. Any decrease at all is an incident: nothing spends from it. */
const PAYOUT: Address = '0xc41c4fed450674169af002b8b3cb47bd70a1958f';
/**
 * Funds agent spending. A decrease is expected, but must match a logged expense.
 *
 * FROM THE ENVIRONMENT, not from source. The payout address above is public by
 * design — it ships in every payment challenge and a buyer cannot pay without
 * it. This one is not. It is funded personally, so publishing it alongside a
 * label saying what it does lets anyone walk its funding history backwards
 * toward whoever tops it up. Set BUDGET_WALLET_ADDRESS as a Fly secret.
 *
 * Unset does NOT mean unmonitored-and-quiet: checkWallets reports the budget
 * wallet as `unknown` with an alert, per this file's own rule that a monitor
 * reporting calm when it is blind is worse than no monitor.
 */
const BUDGET: Address | null = (process.env.BUDGET_WALLET_ADDRESS as Address | undefined) ?? null;

const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type WalletRole = 'payout' | 'budget';
export type WalletStatus = 'steady' | 'increased' | 'DECREASED' | 'unknown' | 'first_read';

export interface WalletReading {
  role: WalletRole;
  address: string;
  usdc: number | null;
  /** The balance this is compared against, or null on a first read. */
  previous_usdc: number | null;
  status: WalletStatus;
  /** Negative when funds left. */
  change_usd: number | null;
  /**
   * When this wallet was last read SUCCESSFULLY — not when the check last ran.
   * A stale timestamp beside `unknown` is the whole point: it says how long we
   * have been blind rather than implying nothing happened.
   */
  last_success_at: string | null;
  /** Present only when something needs a human. */
  alert?: string;
}

export interface WalletMonitorSnapshot {
  /** payout + budget. The one figure finance reconciles the ledger against. */
  funds_on_hand_usd: number | null;
  wallets: WalletReading[];
  /** True when any wallet fell, or when we could not read one. */
  needs_attention: boolean;
  checked_at: string;
}

interface StoredState {
  usdc: number;
  at: string;
}

const dataDir = process.env.DATA_DIR ?? './data';
const statePath = join(dataDir, 'wallet-baseline.json');

/**
 * Last-known balances, persisted.
 *
 * In memory alone a restart resets the baseline, and a drain that happened
 * across a restart would be invisible — the new first read would simply become
 * the new normal. Deploys here are frequent, so that is the common case rather
 * than an edge one.
 */
let baseline: Record<string, StoredState> = {};
let persistent = false;

export function initWalletMonitor(): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(statePath)) {
      baseline = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, StoredState>;
    }
    persistent = true;
  } catch (err) {
    // Degrading to in-memory loses the cross-restart comparison, which means
    // under-detecting rather than false-alarming. Say so rather than pretend.
    console.error('wallet baseline unavailable, comparing in memory only:', err);
  }
}

function persist(): void {
  if (!persistent) return;
  try {
    const tmp = `${statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(baseline));
    renameSync(tmp, statePath);
  } catch (err) {
    persistent = false;
    console.error('wallet baseline write failed, continuing in memory:', err);
  }
}

async function readOne(role: WalletRole, address: Address): Promise<WalletReading> {
  const prior = baseline[address.toLowerCase()];
  const priorUsdc = prior ? prior.usdc : null;

  let usdc: number;
  try {
    const raw = await client.readContract({
      address: USDC,
      abi: BALANCE_ABI,
      functionName: 'balanceOf',
      args: [address],
    });
    usdc = Number.parseFloat(formatUnits(raw, 6));
  } catch {
    return {
      role,
      address,
      usdc: null,
      previous_usdc: priorUsdc,
      status: 'unknown',
      change_usd: null,
      last_success_at: prior?.at ?? null,
      alert: `Could not read the ${role} wallet. This is UNKNOWN, not unchanged — the balance may have moved while we were blind.`,
    };
  }

  const change = priorUsdc === null ? null : Number((usdc - priorUsdc).toFixed(6));
  let status: WalletStatus;
  if (priorUsdc === null) status = 'first_read';
  else if (change! < 0) status = 'DECREASED';
  else if (change! > 0) status = 'increased';
  else status = 'steady';

  const now = new Date().toISOString();
  baseline[address.toLowerCase()] = { usdc, at: now };

  const reading: WalletReading = {
    role,
    address,
    usdc,
    previous_usdc: priorUsdc,
    status,
    change_usd: change,
    last_success_at: now,
  };

  if (status === 'DECREASED') {
    reading.alert =
      role === 'payout'
        ? `PAYOUT WALLET FELL by $${Math.abs(change!).toFixed(6)}. There is no legitimate technical reason for this: nothing in this system holds a key that can move these funds, and the x402 exact scheme pins the destination. Treat as an incident, not a bug to investigate first.`
        : `Budget wallet fell by $${Math.abs(change!).toFixed(6)}. Expected only if it matches an approved, logged expense. If finance has no matching row, something spent money nobody recorded.`;
  }

  return reading;
}

/**
 * Read both wallets and report. Never throws: a monitor that can crash the
 * process it monitors is worse than no monitor.
 */
export async function checkWallets(): Promise<WalletMonitorSnapshot> {
  const wallets = await Promise.all([
    readOne('payout', PAYOUT),
    BUDGET
      ? readOne('budget', BUDGET)
      : Promise.resolve<WalletReading>({
          role: 'budget',
          address: '0x0000000000000000000000000000000000000000',
          usdc: null,
          previous_usdc: null,
          status: 'unknown',
          change_usd: null,
          last_success_at: null,
          alert:
            'BUDGET_WALLET_ADDRESS is not set, so the spend wallet is NOT being monitored. ' +
            'This is UNKNOWN, not steady: a drain would not be detected. Set the Fly secret.',
        }),
  ]);
  persist();

  const readable = wallets.filter((w) => w.usdc !== null);
  const fundsOnHand =
    readable.length === wallets.length
      ? Number(readable.reduce((t, w) => t + (w.usdc ?? 0), 0).toFixed(6))
      : null; // A partial sum is a wrong number wearing a right one's clothes.

  for (const w of wallets) {
    if (w.alert) console.error(`[wallet] ${w.alert}`);
  }

  return {
    funds_on_hand_usd: fundsOnHand,
    wallets,
    needs_attention: wallets.some((w) => w.status === 'DECREASED' || w.status === 'unknown'),
    checked_at: new Date().toISOString(),
  };
}
