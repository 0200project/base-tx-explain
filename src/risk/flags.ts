import type { Address } from 'viem';
import type { Classification } from '../decode/classify.js';
import { isUnlimitedApproval } from '../decode/classify.js';
import type { DecodedEvent } from '../decode/events.js';
import { getTokenSupply, shortAddress } from '../decode/tokens.js';
import { getLabel } from '../labels.js';
import type { AssetMovement, CheckStatus, ChecksPerformed, RiskFlag } from '../types.js';
import { DRAINER_REFRESH_MS, drainerListAgeMs, drainerListLoaded, drainerSourceHealth, isKnownDrainer } from './drainers.js';
import { isFirstInteraction } from './firstTime.js';
import { verificationStatus } from './verification.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const HOUR_MS = 60 * 60 * 1000;

interface FlagContext {
  from: Address;
  to: Address | null;
  blockNumber: bigint;
  reverted: boolean;
  classification: Classification;
  events: DecodedEvent[];
  movements: AssetMovement[];
}

export interface RiskAssessment {
  flags: RiskFlag[];
  checks: ChecksPerformed;
}

/**
 * Roll per-address outcomes into one status.
 *
 * `total` counts every address that warranted this check, including any dropped
 * by CHECK_CAP — so a transaction that fans out past the cap reports `partial`
 * rather than claiming full coverage.
 *
 * `permanent` counts the subset of `indeterminate` answers that no retry can
 * improve, because the method cannot answer for this input rather than because a
 * lookup failed. When every answer we got is of that kind the honest status is
 * `inconclusive`: nothing upstream was down, so saying `unavailable` would blame
 * infrastructure for a limit of the method.
 */
function rollUp(
  total: number,
  attempted: number,
  indeterminate: number,
  permanent = 0,
): CheckStatus {
  if (total === 0) return 'not_applicable';
  // Zero usable answers is `unavailable` however many addresses we tried. This
  // condition previously also required `attempted === total`, which meant an
  // address dropped by CHECK_CAP upgraded an all-indeterminate result from
  // `unavailable` to `partial`: more unchecked addresses improved the reported
  // status, which is exactly backwards.
  if (indeterminate >= attempted) {
    // A single failed lookup among the permanent ones still means a retry might
    // learn something, so the transient reading wins any mix.
    return indeterminate > 0 && permanent >= indeterminate ? 'inconclusive' : 'unavailable';
  }
  if (indeterminate > 0 || attempted < total) return 'partial';
  return 'ok';
}

/**
 * Assemble risk_flags. Every check degrades to "no flag" rather than an error —
 * a risk flag must always mean evidence was found, never that a lookup failed.
 *
 * Because of that, the flags alone cannot be read as a verdict: an unreachable
 * upstream produces the same empty list as a transaction with nothing wrong. The
 * returned `checks` says which lookups actually ran, so the caller can tell those
 * two cases apart instead of defaulting to the reassuring one.
 */
export async function buildRiskFlags(ctx: FlagContext): Promise<RiskAssessment> {
  const flags: RiskFlag[] = [];
  const { from, to, classification, events, movements } = ctx;
  const sender = from.toLowerCase();
  const action = classification.action;

  if (ctx.reverted) {
    flags.push({ flag: 'transaction_reverted', detail: 'The transaction reverted; no state changes took effect (gas was still paid).' });
  }

  for (const e of events) {
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved)) {
      const operator = String(e.args.operator ?? '');
      const operatorLabel = getLabel(operator)?.label;
      flags.push({
        flag: 'approval_for_all',
        detail: `Granted ${operatorLabel ?? shortAddress(operator)} operator control over ALL tokens in collection ${shortAddress(e.emitter)} — this permits future transfers without further signatures.`,
      });
    }
  }

  // Unlimited-approval detection. A fixed 2^128 threshold is evadable (grant
  // 2^128 - 1 and stay under it), so prefer the token's own totalSupply: an
  // allowance at or above the entire supply can never be a real, bounded amount.
  // Fall back to the 2^128 rule only when the supply read is unavailable.
  const unlimitedFlags = await Promise.all(
    events
      .filter((e) => e.kind === 'erc20_approval')
      .map(async (e) => {
        const value = e.args.value as bigint | undefined;
        if (value === undefined) return null;
        const supply = await getTokenSupply(e.emitter, ctx.blockNumber);
        const bounded = supply !== null && supply > 0n;
        const unlimited = bounded ? value >= supply : isUnlimitedApproval(value);
        if (!unlimited) return null;
        const spender = String(e.args.spender ?? '');
        const spenderLabel = getLabel(spender)?.label;
        const scope = bounded
          ? `more than the entire circulating supply of token ${shortAddress(e.emitter)}`
          : `an effectively unlimited amount of token ${shortAddress(e.emitter)}`;
        return {
          flag: 'unlimited_approval' as const,
          detail: `Approved ${spenderLabel ?? shortAddress(spender)} to spend ${scope}.`,
          spender: spender.toLowerCase(),
        };
      }),
  );
  // Spenders granted an unbounded allowance. These are the addresses most worth
  // spending a scarce network lookup on, so they sort to the front of the queue.
  const unlimitedSpenders = new Set<string>();
  for (const f of unlimitedFlags) {
    if (!f) continue;
    unlimitedSpenders.add(f.spender);
    flags.push({ flag: f.flag, detail: f.detail });
  }

  // Addresses that gained power or received the sender's assets in this tx.
  const exposedAddresses = new Set<string>();
  if (to) exposedAddresses.add(to.toLowerCase());
  for (const e of events) {
    if (e.kind === 'erc20_approval' && e.args.spender) exposedAddresses.add(String(e.args.spender).toLowerCase());
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved) && e.args.operator) {
      exposedAddresses.add(String(e.args.operator).toLowerCase());
    }
  }
  for (const m of movements) {
    if (m.from.toLowerCase() === sender) exposedAddresses.add(m.to.toLowerCase());
  }

  const drainerChecks = await Promise.all(
    [...exposedAddresses].map(async (a) => ((await isKnownDrainer(a)) ? a : null)),
  );
  // Read AFTER the lookups. On the first request after a deploy the list is
  // still empty when the lookups start, but isKnownDrainer awaits the initial
  // load before answering — so reading first reported `unavailable` on answers
  // that were in fact good, on every cold start. Reading after is safe because
  // the set is only ever replaced wholesale with a non-empty one, never emptied.
  const drainerAge = drainerListLoaded() ? drainerListAgeMs() : null;
  for (const hit of drainerChecks) {
    if (hit) {
      flags.push({
        flag: 'known_drainer',
        detail: `${shortAddress(hit)} appears on a public scam/drainer blacklist (ScamSniffer database).`,
      });
    }
  }

  // Verification + first-interaction checks only for the address being trusted,
  // and only when this tx actually extends trust (assets moved or approval granted).
  const extendsTrust =
    movements.some((m) => m.from.toLowerCase() === sender) ||
    events.some((e) => e.kind === 'erc20_approval' || (e.kind === 'approval_for_all' && Boolean(e.args.approved))) ||
    (!ctx.reverted && action === 'contract_interaction');

  // Resolve the address(es) this tx actually extends trust TO. For an approval
  // that is the spender/operator, NOT `to` (which is the token contract) —
  // otherwise a drain-enabling approve() to a fresh, unverified attacker
  // contract is never checked, and is skipped outright when the token is
  // labeled (e.g. USDC). `to` still matters for the call itself (e.g. an
  // unverified router in an approve+swap), so include BOTH — spenders first so
  // they win the CHECK_CAP when a tx has many.
  const targets: Array<{ addr: string; role: 'spender' | 'contract' }> = [];
  const seen = new Set<string>();
  const addTarget = (raw: string | undefined | null, role: 'spender' | 'contract') => {
    if (!raw) return;
    const lower = raw.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    targets.push({ addr: lower, role });
  };
  for (const e of events) {
    if (e.kind === 'erc20_approval' && e.args.spender) addTarget(String(e.args.spender), 'spender');
    if (e.kind === 'approval_for_all' && Boolean(e.args.approved) && e.args.operator) {
      addTarget(String(e.args.operator), 'spender');
    }
  }
  if (to && extendsTrust && action !== 'eth_transfer') addTarget(to, 'contract');

  // Only unfamiliar addresses warrant a lookup: skip the sender, the zero
  // address, and anything already labeled as known infrastructure. Cap the
  // number of upstream checks so a crafted tx cannot fan out unboundedly.
  const CHECK_CAP = 3;
  const eligible = targets.filter(
    (t) => t.addr !== sender && t.addr !== ZERO_ADDRESS && !getLabel(t.addr),
  );

  // Order the queue by how much damage the address could do, not by the order
  // its event happened to appear in. `erc20_approval` is matched on topic
  // signature alone and cannot be emitter-gated (a genuine approval legitimately
  // comes from whichever token contract), so any contract can emit counterfeit
  // Approval events naming junk spenders. Left in event order, three such logs
  // push a real drain-enabling spender past the cap for the price of three log
  // emissions. Sorting unbounded approvals first means padding only displaces
  // the real target if the padding is itself unlimited, which is both more
  // expensive and independently flagged.
  const priority = (t: { addr: string; role: 'spender' | 'contract' }): number => {
    if (t.role === 'spender' && unlimitedSpenders.has(t.addr)) return 0;
    if (t.role === 'spender') return 1;
    return 2;
  };
  const queue = [...eligible].sort((a, b) => priority(a) - priority(b));
  const toCheck = queue.slice(0, CHECK_CAP);
  const uncheckedAddresses = queue.slice(CHECK_CAP).map((t) => t.addr);

  // Run the lookups concurrently but emit flags in a deterministic order
  // (toCheck order, unverified before first_time per address).
  const trustResults = await Promise.all(
    toCheck.map(async (t) => {
      const address = t.addr as Address;
      const [status, first] = await Promise.all([
        verificationStatus(address),
        isFirstInteraction(from, address, ctx.blockNumber),
      ]);
      return { ...t, status, first };
    }),
  );
  for (const { addr, role, status, first } of trustResults) {
    const noun = role === 'spender' ? 'Approved spender' : 'Target contract';
    if (status === 'unverified') {
      flags.push({
        flag: 'unverified_contract',
        detail: `${noun} ${shortAddress(addr)} has no verified source code on Sourcify${process.env.ETHERSCAN_API_KEY ? ' or Basescan' : ''}.`,
      });
    }
    if (first.kind === 'first') {
      const what = role === 'spender' ? 'approved spender' : 'counterparty';
      flags.push({
        flag: 'first_time_counterparty',
        detail: `This is the sender's first recorded transaction with ${what} ${shortAddress(addr)} on Base.`,
      });
    }
  }

  // --- Coverage ---
  // Counted against `eligible`, not `toCheck`, so addresses dropped by CHECK_CAP
  // lower the reported coverage. Otherwise a transaction touching many unfamiliar
  // addresses would report full coverage of the three we happened to look at,
  // which is exactly the reassurance an attacker would want to manufacture.
  const verifyIndeterminate = trustResults.filter((r) => r.status === 'unknown').length;
  // Truncated histories are counted separately from unreachable ones: both leave
  // us without an answer, but only the second is worth retrying.
  const firstTruncated = trustResults.filter((r) => r.first.kind === 'truncated').length;
  const firstIndeterminate =
    trustResults.filter((r) => r.first.kind === 'unreachable').length + firstTruncated;

  // A list older than its own refresh interval is answering from data we can no
  // longer vouch for. Reporting that as `ok` is the precise over-claim this
  // whole field exists to prevent, so age degrades the status.
  const drainerStale = drainerAge !== null && drainerAge > DRAINER_REFRESH_MS;
  // A merge that lost a source is answering from partial coverage. The merged set
  // is still non-empty, so nothing else here would notice: `loaded` and `age` both
  // read healthy while half the blacklist is missing. Degrade on the source count
  // for the same reason age degrades — reporting reduced coverage as `ok` is the
  // over-claim this field exists to prevent.
  const sources = drainerSourceHealth();
  const drainerIncomplete = sources.tried > 0 && sources.ok < sources.tried;
  const drainerStatus: CheckStatus =
    exposedAddresses.size === 0
      ? 'not_applicable'
      : drainerAge === null
        ? 'unavailable'
        : drainerStale || drainerIncomplete
          ? 'partial'
          : 'ok';

  const checks: ChecksPerformed = {
    contract_verification: rollUp(eligible.length, trustResults.length, verifyIndeterminate),
    first_interaction: rollUp(eligible.length, trustResults.length, firstIndeterminate, firstTruncated),
    drainer_blacklist: drainerStatus,
    unchecked_addresses: uncheckedAddresses,
    note: null,
  };

  const degraded: string[] = [];
  if (checks.contract_verification === 'unavailable') {
    degraded.push('source-code verification could not be checked');
  } else if (checks.contract_verification === 'partial') {
    degraded.push('source-code verification ran on only some addresses');
  }
  if (checks.first_interaction === 'unavailable') {
    degraded.push('counterparty history could not be checked');
  } else if (checks.first_interaction === 'inconclusive') {
    // Deliberately does not say anything "failed": nothing did. Saying so would
    // both misdescribe the result and invite a pointless retry.
    degraded.push(
      'the sender has more transaction history than this check reads, so whether this was a ' +
        'first interaction cannot be established for them — no lookup failed, and a retry would ' +
        'return the same',
    );
  } else if (checks.first_interaction === 'partial') {
    degraded.push('counterparty history ran on only some addresses');
  }
  if (checks.drainer_blacklist === 'unavailable') {
    degraded.push('the scam/drainer blacklist was unavailable');
  } else if (drainerStale && drainerAge !== null) {
    degraded.push(
      `the scam/drainer blacklist has not refreshed in ${Math.floor(drainerAge / HOUR_MS)} hours`,
    );
  }
  if (uncheckedAddresses.length > 0) {
    degraded.push(
      `${uncheckedAddresses.length} address(es) involved in this transaction were not looked up ` +
        `at all and are listed in unchecked_addresses`,
    );
  }
  if (degraded.length > 0) {
    checks.note =
      `${degraded.join('; ')}. No flag was emitted for those checks, and that absence ` +
      'carries no information: treat it as unknown, not as clean.';
  }

  return { flags, checks };
}
