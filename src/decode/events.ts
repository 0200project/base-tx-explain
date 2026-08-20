import {
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from 'viem';

/**
 * Semantic tag the classifier keys off. One event signature can map to
 * different tags depending on the emitter (e.g. Deposit on WETH vs elsewhere) —
 * that disambiguation happens in the classifier, not here.
 */
export type EventKind =
  | 'erc20_transfer'
  | 'erc721_transfer'
  | 'erc20_approval'
  | 'erc721_approval'
  | 'approval_for_all'
  | 'erc1155_single'
  | 'erc1155_batch'
  | 'weth_deposit'
  | 'weth_withdrawal'
  | 'univ3_swap'
  | 'univ2_swap'
  | 'univ4_swap'
  | 'solidly_swap'
  | 'seaport_order'
  | 'user_operation'
  | 'eas_attested'
  | 'aave_supply'
  | 'aave_withdraw'
  | 'aave_borrow'
  | 'aave_repay'
  | 'comet_supply'
  | 'comet_withdraw'
  | 'bridge_deposit_finalized'
  | 'bridge_withdrawal_initiated'
  | 'bridge_eth_finalized'
  | 'bridge_eth_initiated'
  | 'bridge_erc20_finalized'
  | 'bridge_erc20_initiated'
  | 'staked'
  | 'stake_withdrawn'
  | 'reward_paid'
  | 'merkle_claimed'
  | 'name_registered'
  | 'lp_increase'
  | 'lp_decrease'
  | 'lp_collect'
  | 'v2_lp_mint'
  | 'v2_lp_burn'
  | 'message_relayed'
  | 'message_sent';

interface KnownEvent {
  kind: EventKind;
  abi: AbiEvent;
}

function ev(kind: EventKind, signature: string): [Hex, KnownEvent] {
  const abi = parseAbiItem(signature) as AbiEvent;
  return [toEventSelector(abi), { kind, abi }];
}

// Transfer/Approval on ERC-20 and ERC-721 share a topic0; they are told apart
// by indexed-parameter count (ERC-721 indexes tokenId → 4 topics, ERC-20 → 3).
const TRANSFER_TOPIC = toEventSelector(
  parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)') as AbiEvent,
);
const APPROVAL_TOPIC = toEventSelector(
  parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)') as AbiEvent,
);

const ERC20_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
) as AbiEvent;
const ERC721_TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
) as AbiEvent;
const ERC20_APPROVAL = parseAbiItem(
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
) as AbiEvent;
const ERC721_APPROVAL = parseAbiItem(
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
) as AbiEvent;

const KNOWN_EVENTS = new Map<Hex, KnownEvent>([
  ev('approval_for_all', 'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)'),
  ev(
    'erc1155_single',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  ),
  ev(
    'erc1155_batch',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  ),
  ev('weth_deposit', 'event Deposit(address indexed dst, uint256 wad)'),
  ev('weth_withdrawal', 'event Withdrawal(address indexed src, uint256 wad)'),
  ev(
    'univ3_swap',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ),
  ev(
    'univ2_swap',
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  ),
  ev(
    'univ4_swap',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  ),
  ev(
    'solidly_swap',
    'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
  ),
  ev(
    'seaport_order',
    'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
  ),
  ev(
    'user_operation',
    'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
  ),
  ev(
    'eas_attested',
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  ),
  ev(
    'aave_supply',
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  ),
  ev(
    'aave_withdraw',
    'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  ),
  ev(
    'aave_borrow',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  ),
  ev(
    'aave_repay',
    'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  ),
  ev('comet_supply', 'event Supply(address indexed from, address indexed dst, uint256 amount)'),
  ev('comet_withdraw', 'event Withdraw(address indexed src, address indexed to, uint256 amount)'),
  ev(
    'bridge_deposit_finalized',
    'event DepositFinalized(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
  ),
  ev(
    'bridge_withdrawal_initiated',
    'event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)',
  ),
  ev(
    'bridge_eth_finalized',
    'event ETHBridgeFinalized(address indexed from, address indexed to, uint256 amount, bytes extraData)',
  ),
  ev(
    'bridge_eth_initiated',
    'event ETHBridgeInitiated(address indexed from, address indexed to, uint256 amount, bytes extraData)',
  ),
  ev(
    'bridge_erc20_finalized',
    'event ERC20BridgeFinalized(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)',
  ),
  ev(
    'bridge_erc20_initiated',
    'event ERC20BridgeInitiated(address indexed localToken, address indexed remoteToken, address indexed from, address to, uint256 amount, bytes extraData)',
  ),
  ev('staked', 'event Staked(address indexed user, uint256 amount)'),
  ev('stake_withdrawn', 'event Withdrawn(address indexed user, uint256 amount)'),
  ev('reward_paid', 'event RewardPaid(address indexed user, uint256 reward)'),
  ev('merkle_claimed', 'event Claimed(uint256 index, address account, uint256 amount)'),
  ev(
    'name_registered',
    'event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 expires)',
  ),
  // Concentrated-liquidity position managers (Uniswap V3 style, incl. Aerodrome CL / Pancake V3)
  ev(
    'lp_increase',
    'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  ),
  ev(
    'lp_decrease',
    'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  ),
  ev('lp_collect', 'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)'),
  // V2/Solidly pair liquidity
  ev('v2_lp_mint', 'event Mint(address indexed sender, uint256 amount0, uint256 amount1)'),
  ev('v2_lp_burn', 'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)'),
  // OP-stack cross-domain messenger
  ev('message_relayed', 'event RelayedMessage(bytes32 indexed msgHash)'),
  ev(
    'message_sent',
    'event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)',
  ),
]);

export interface DecodedEvent {
  kind: EventKind;
  emitter: Address;
  args: Record<string, unknown>;
  logIndex: number;
}

export function decodeKnownLog(log: Log): DecodedEvent | null {
  const topic0 = log.topics[0];
  if (!topic0) return null;
  const emitter = log.address;
  const logIndex = log.logIndex ?? -1;

  const tryDecode = (abi: AbiEvent, kind: EventKind): DecodedEvent | null => {
    try {
      const { args } = decodeEventLog({ abi: [abi], data: log.data, topics: log.topics });
      return { kind, emitter, args: args as unknown as Record<string, unknown>, logIndex };
    } catch {
      return null;
    }
  };

  if (topic0 === TRANSFER_TOPIC) {
    return log.topics.length === 4
      ? tryDecode(ERC721_TRANSFER, 'erc721_transfer')
      : tryDecode(ERC20_TRANSFER, 'erc20_transfer');
  }
  if (topic0 === APPROVAL_TOPIC) {
    return log.topics.length === 4
      ? tryDecode(ERC721_APPROVAL, 'erc721_approval')
      : tryDecode(ERC20_APPROVAL, 'erc20_approval');
  }

  const known = KNOWN_EVENTS.get(topic0 as Hex);
  if (!known) return null;
  return tryDecode(known.abi, known.kind);
}
