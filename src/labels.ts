export type LabelCategory =
  | 'dex'
  | 'bridge'
  | 'nft_marketplace'
  | 'token'
  | 'lending'
  | 'entrypoint'
  | 'attestation'
  | 'registry'
  | 'staking'
  | 'infra'
  | 'other';

export interface AddressLabel {
  label: string;
  category: LabelCategory;
}

// Base mainnet address labels. OP-stack predeploys and cross-chain singletons
// are fixed by construction; everything else was verified against official
// docs / Basescan verified names on 2026-08-19. Keys MUST be lowercase.
export const LABELS: Record<string, AddressLabel> = {
  // --- OP-stack predeploys (fixed on every OP chain) ---
  '0x4200000000000000000000000000000000000006': { label: 'WETH', category: 'token' },
  '0x4200000000000000000000000000000000000007': { label: 'Base L2CrossDomainMessenger', category: 'bridge' },
  '0x4200000000000000000000000000000000000010': { label: 'Base Standard Bridge', category: 'bridge' },
  '0x4200000000000000000000000000000000000015': { label: 'Base L1Block (system)', category: 'infra' },
  '0x4200000000000000000000000000000000000016': { label: 'Base L2ToL1MessagePasser', category: 'bridge' },
  '0x4200000000000000000000000000000000000020': { label: 'EAS Schema Registry', category: 'attestation' },
  '0x4200000000000000000000000000000000000021': { label: 'Ethereum Attestation Service', category: 'attestation' },

  // --- Cross-chain singletons ---
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { label: 'Permit2 (Uniswap)', category: 'infra' },
  '0xca11bde05977b3631167028862be2a173976ca11': { label: 'Multicall3', category: 'infra' },
  '0x40a2accbd92bca938b02010e17a5b8929b49130d': { label: 'Safe MultiSendCallOnly v1.3', category: 'infra' },
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { label: 'ERC-4337 EntryPoint v0.6', category: 'entrypoint' },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { label: 'ERC-4337 EntryPoint v0.7', category: 'entrypoint' },
  '0x4337084d9e255ff0702461cf8895ce9e3b5ff108': { label: 'ERC-4337 EntryPoint v0.8', category: 'entrypoint' },
  '0x433709009b8330fda32311df1c2afa402ed8d009': { label: 'ERC-4337 EntryPoint v0.9', category: 'entrypoint' },

  // --- Major Base tokens ---
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { label: 'USDC', category: 'token' },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { label: 'USDbC (bridged USDC)', category: 'token' },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { label: 'cbBTC', category: 'token' },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { label: 'cbETH', category: 'token' },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { label: 'DAI', category: 'token' },
  '0x4ed4e862860bed51a9570b96d89af5e1b0efefed': { label: 'DEGEN', category: 'token' },
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { label: 'AERO (Aerodrome)', category: 'token' },

  // --- DEX routers / aggregators ---
  '0x6ff5693b99212da76ad316178a184ab56d299b43': { label: 'Uniswap Universal Router', category: 'dex' },
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { label: 'Uniswap Universal Router (V2 support)', category: 'dex' },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { label: 'Uniswap V3 SwapRouter02', category: 'dex' },
  '0x498581ff718922c3f8e6a244956af099b2652b2b': { label: 'Uniswap V4 PoolManager', category: 'dex' },
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': { label: 'Uniswap V2 Router02', category: 'dex' },
  '0x33128a8fc17869897dce68ed026d694621f6fdfd': { label: 'Uniswap V3 Factory', category: 'infra' },
  '0x8909dc15e40173ff4699343b6eb8132c65e18ec6': { label: 'Uniswap V2 Factory', category: 'infra' },
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': { label: 'Aerodrome Router', category: 'dex' },
  '0x420dd381b31aef6683db6b902084cb0ffece40da': { label: 'Aerodrome PoolFactory', category: 'infra' },
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': { label: '0x Exchange Proxy', category: 'dex' },
  '0x111111125421ca6dc452d289314280a0f8842a65': { label: '1inch AggregationRouterV6', category: 'dex' },
  '0x67d03631fe51b741c0c00c4e16eb662ac84381df': { label: 'OKX DEX Router', category: 'dex' },
  '0x57df6092665eb6058de53939612413ff4b09114e': { label: 'OKX DEX TokenApprove', category: 'infra' },
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': { label: 'KyberSwap MetaAggregationRouterV2', category: 'dex' },

  // --- NFT marketplaces / mint infra ---
  '0x0000000000000068f116a894984e2db1123eb395': { label: 'Seaport 1.6 (OpenSea)', category: 'nft_marketplace' },
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc': { label: 'Seaport 1.5 (OpenSea)', category: 'nft_marketplace' },
  '0x777777c338d93e2c7adf08d102d45ca7cc4ed021': { label: 'Zora 1155 Factory', category: 'nft_marketplace' },
  '0x7777777f279eba3d3ad8f4e708545291a6fdba8b': { label: 'Zora Protocol Rewards', category: 'nft_marketplace' },

  // --- Bridges ---
  '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64': { label: 'Across SpokePool', category: 'bridge' },
  '0xdc181bd607330aeebef6ea62e03e5e1fb4b6f7c7': { label: 'Stargate V2 Pool (ETH)', category: 'bridge' },
  '0x27a16dc786820b16e5c9028b75b99f6f604b5d26': { label: 'Stargate V2 Pool (USDC)', category: 'bridge' },
  '0x5634c4a5fed09819e3c46d86a965dd9447d86e47': { label: 'Stargate V2 TokenMessaging', category: 'bridge' },
  '0xa5f565650890fba1824ee0f21ebbbf660a179934': { label: 'Relay Receiver', category: 'bridge' },
  '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f': { label: 'Relay ERC20Router', category: 'bridge' },
  '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be': { label: 'Relay ApprovalProxy', category: 'bridge' },

  // --- Lending ---
  '0xa238dd80c259a72e81d7e4664a9801593f98d1c5': { label: 'Aave V3 Pool', category: 'lending' },
  '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c': { label: 'Moonwell Comptroller', category: 'lending' },
  '0xb125e6687d4313864e53df431d5425969c15eb2f': { label: 'Compound V3 (cUSDCv3)', category: 'lending' },

  // --- Names / registries ---
  '0xb94704422c2a1e396835a571837aa5ae53285a95': { label: 'Basenames Registry', category: 'registry' },
  '0x03c4738ee98ae44591e1a4a4f3cab6641d95dd9a': { label: 'Basenames BaseRegistrar', category: 'registry' },
  '0x4ccb0bb02fcaba27e82a56646e81d8c5bc4119a5': { label: 'Basenames RegistrarController', category: 'registry' },
  '0xa7d2607c6bd39ae9521e514026cbb078405ab322': { label: 'Basenames RegistrarController (upgradeable)', category: 'registry' },
  '0xc6d566a56a1aff6508b41f6c90ff131615583bcd': { label: 'Basenames L2Resolver', category: 'registry' },

  // --- Oracles / misc ---
  '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70': { label: 'Chainlink ETH/USD Feed', category: 'infra' },
  '0xd152f549545093347a162dce210e7293f1452150': { label: 'Disperse.app', category: 'other' },

  // --- Tokens: canonical issuances. The impersonation guard treats these as
  // the real contract for their ticker, so an addition here is a trust
  // assertion, not decoration. Every one verified from the issuer AND read
  // back on-chain (symbol + decimals) before being added.
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { label: 'USDT', category: 'token' },
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42': { label: 'EURC', category: 'token' },
  '0x820c137fa70c8691f0e44dc420a5e53c168921dc': { label: 'USDS', category: 'token' },
  '0x5875eee11cf8398102fdad704c9e96607675467a': { label: 'sUSDS', category: 'token' },
  '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee': { label: 'GHO', category: 'token' },
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { label: 'wstETH', category: 'token' },
  '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a': { label: 'weETH', category: 'token' },
  '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c': { label: 'rETH', category: 'token' },
  '0x2416092f143378750bb29b79ed961ab195cceea5': { label: 'ezETH', category: 'token' },
  '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b': { label: 'tBTC', category: 'token' },
  '0xecac9c5f704e954931349da37f60e39f515c11c1': { label: 'LBTC', category: 'token' },

  // --- Lending ---
  '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb': { label: 'Morpho Blue', category: 'lending' },
  '0xff62a7c278c62ed665133147129245053bbf5918': { label: 'MetaMorpho Factory', category: 'lending' },
  '0x4501125508079a99ebbebce205dec9593c2b5857': { label: 'Morpho Vault V2 Factory', category: 'lending' },

  // --- DEX / AMM ---
  '0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7': { label: 'Uniswap Universal Router', category: 'dex' },
  '0x7c5f5a4bbd8fd63184577525326123b519429bdc': { label: 'Uniswap V4 Position Manager', category: 'dex' },
  '0xbe6d8f0d05cc4be24d5167a3ef062215be6d18a5': { label: 'Aerodrome Slipstream Router', category: 'dex' },
  '0x698cb2b6dd822994581fea6ea4fc755d1363a92f': { label: 'Aerodrome Slipstream Router', category: 'dex' },
  '0x827922686190790b37229fd06084350e74485b72': { label: 'Aerodrome Slipstream Position Manager', category: 'dex' },
  '0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53': { label: 'Aerodrome Slipstream Position Manager', category: 'dex' },
  '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a': { label: 'Aerodrome Slipstream Factory', category: 'dex' },
  '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef': { label: 'Aerodrome Slipstream Factory', category: 'dex' },
  '0x16613524e02ad97edfef371bc883f2f5d6c480a5': { label: 'Aerodrome Voter', category: 'dex' },
  '0xba12222222228d8ba445958a75a0704d566bf2c8': { label: 'Balancer V2 Vault', category: 'dex' },
  '0xba1333333333a1ba1108e8412f11850a5c319ba9': { label: 'Balancer V3 Vault', category: 'dex' },
  '0x3f170631ed9821ca51a59d996ab095162438dc10': { label: 'Balancer V3 Router', category: 'dex' },
  '0x85a80afee867adf27b50bdb7b76da70f1e853062': { label: 'Balancer V3 BatchRouter', category: 'dex' },
  '0x4f37a9d177470499a2dd084621020b023fcffc1f': { label: 'Curve Router', category: 'dex' },
  '0x888888888889758f76e7103c6cbf23abbf58f946': { label: 'Pendle Router', category: 'dex' },
  '0x81e80a50e56d10c501ff17b5fe2f662bd9ea4590': { label: 'Pendle Market Factory', category: 'dex' },

  // --- Bridges and cross-chain messaging ---
  '0x1a44076050125825900e736c501f859c50fe728c': { label: 'LayerZero EndpointV2', category: 'bridge' },

  // --- NFT / creator platforms ---
  '0x777777722d078c97c6ad07d9f36801e653e356ae': { label: 'Zora Timed Sale Strategy', category: 'nft_marketplace' },

  // --- Registries ---
  '0x00000000fc84484d585c3cf48d213424dfde43fd': { label: 'Farcaster Tier Registry', category: 'registry' },

  // --- Smart accounts and infrastructure ---
  '0xba5ed110efdba3d005bfc882d75358acbbb85842': { label: 'Coinbase Smart Wallet Factory', category: 'infra' },
  '0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a': { label: 'Coinbase Smart Wallet Factory (v1)', category: 'infra' },
  '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67': { label: 'Safe Proxy Factory 1.4.1', category: 'infra' },
  '0x14f2982d601c9458f93bd70b218933a6f8165e7b': { label: 'Safe Proxy Factory 1.5.0', category: 'infra' },
  '0x29fcb43b46531bca003ddc8fcb67ffe91900c762': { label: 'Safe Singleton 1.4.1', category: 'infra' },
  '0x41675c099f32341bf84bfc5382af534df5c7461a': { label: 'Safe Singleton 1.4.1', category: 'infra' },
  '0xedd160febbd92e350d4d398fb636302fccd67c7e': { label: 'Safe Singleton 1.5.0', category: 'infra' },
  '0xff51a5898e281db6dfc7855790607438df2ca44b': { label: 'Safe Singleton 1.5.0', category: 'infra' },
  '0x458138fc0d67027e9a6778ef40a6ffc318c69061': { label: 'Chainlink USDC/USD Feed', category: 'infra' },
  '0x07da0e54543a844a80abe69c8a12f22b3aa59f9d': { label: 'Chainlink cbBTC/USD Feed', category: 'infra' },

};

export const WETH_ADDRESS = '0x4200000000000000000000000000000000000006' as const;

export function getLabel(address: string | null | undefined): AddressLabel | null {
  if (!address) return null;
  return LABELS[address.toLowerCase()] ?? null;
}
