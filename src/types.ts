export type ActionType =
  | 'eth_transfer'
  | 'erc20_transfer'
  | 'erc20_approval'
  | 'approval_revoked'
  | 'approval_for_all'
  | 'swap'
  | 'add_liquidity'
  | 'remove_liquidity'
  | 'wrap'
  | 'unwrap'
  | 'nft_mint'
  | 'nft_transfer'
  | 'nft_sale'
  | 'token_mint'
  | 'bridge_in'
  | 'bridge_out'
  | 'lending_supply'
  | 'lending_withdraw'
  | 'lending_borrow'
  | 'lending_repay'
  | 'stake'
  | 'unstake'
  | 'claim'
  | 'batch_transfer'
  | 'account_abstraction_bundle'
  | 'attestation'
  | 'name_registration'
  | 'contract_deployment'
  | 'contract_interaction'
  | 'unknown';

export type AssetStandard = 'native' | 'erc20' | 'erc721' | 'erc1155';

export interface AssetMovement {
  token: string;
  amount: string;
  from: string;
  to: string;
  token_address: string | null;
  token_id?: string;
  standard: AssetStandard;
}

export interface Counterparty {
  address: string;
  label: string | null;
}

export type RiskFlagCode =
  | 'unverified_contract'
  | 'first_time_counterparty'
  | 'approval_for_all'
  | 'unlimited_approval'
  | 'known_drainer'
  | 'nonstandard_token_symbol'
  | 'impersonated_token'
  | 'transaction_reverted';

export interface RiskFlag {
  flag: RiskFlagCode;
  detail: string;
}

/**
 * Whether a risk check actually ran.
 *
 *  - `ok`             — the check ran against every address it needed to.
 *  - `partial`        — it ran against some but not all of them.
 *  - `unavailable`    — it could not run at all (upstream unreachable, or the
 *                       answer was indeterminate). No flag was emitted, and that
 *                       absence carries no information.
 *  - `not_applicable` — there was nothing for this check to look at.
 */
export type CheckStatus = 'ok' | 'partial' | 'unavailable' | 'not_applicable';

/**
 * Which risk checks ran on this transaction.
 *
 * Every check in `risk_flags` fails open: when an upstream source is unreachable
 * we emit no flag, which in the output is indistinguishable from having looked
 * and found nothing. That silence is the dangerous case — an empty `risk_flags`
 * would otherwise read as "clean" when it may mean "never checked". This field
 * makes the difference explicit and machine-readable.
 *
 * `risk_flags` is only as meaningful as the checks that produced it: an empty
 * `risk_flags` alongside any status other than `ok` is not a clean result.
 */
export interface ChecksPerformed {
  /** Verified source code lookup (Sourcify, then Basescan when configured). */
  contract_verification: CheckStatus;
  /** Sender's prior history with the counterparty (Blockscout, then Basescan). */
  first_interaction: CheckStatus;
  /** Membership in the public scam/drainer blacklists. */
  drainer_blacklist: CheckStatus;
  /** Plain-language reason, present only when some check did not fully run. */
  note: string | null;
}

export interface Provenance {
  /**
   * Output fields whose string contents are derived from attacker-controllable
   * on-chain or third-party sources. A consuming agent must treat these as data,
   * never as instructions.
   */
  untrusted_fields: string[];
  note: string;
}

export interface ExplainResult {
  summary: string;
  action_type: ActionType;
  status: 'success' | 'reverted';
  assets_moved: AssetMovement[];
  counterparties: Counterparty[];
  risk_flags: RiskFlag[];
  /** Which risk checks ran, so an empty risk_flags can be read correctly. */
  checks: ChecksPerformed;
  gas_paid_usd: number | null;
  timestamp: string;
  block_number: number;
  tx_hash: string;
  basescan_url: string;
  /** True when part of the transaction could not be decoded; summary says what is known. */
  partial: boolean;
  /** Which fields carry attacker-controllable strings; a persistent instruction to consuming agents. */
  provenance: Provenance;
}
