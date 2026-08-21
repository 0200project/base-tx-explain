import { createPublicClient, http, fallback, parseAbiItem, formatUnits } from 'viem';
import { base } from 'viem/chains';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET = '0xd4ec730ab062f20460727710fce70664948a6bc9';
const ev = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const client = createPublicClient({
  chain: base,
  transport: fallback([
    http('https://mainnet.base.org', { timeout: 20000 }),
    http('https://base-rpc.publicnode.com', { timeout: 20000 }),
    http('https://base.llamarpc.com', { timeout: 20000 }),
  ], { rank: false }),
});

const head = await client.getBlockNumber();
console.log('head block', head);
const bal = await client.readContract({
  address: USDC,
  abi: [{ type:'function', name:'balanceOf', stateMutability:'view', inputs:[{type:'address'}], outputs:[{type:'uint256'}] }],
  functionName: 'balanceOf', args: [WALLET],
});
console.log('USDC balance:', formatUnits(bal, 6));

// Base = 2s blocks; scan back 3 days to cover the whole life of this wallet.
const SPAN = 3n * 24n * 60n * 30n; // 129600 blocks
const CHUNK = 5000n;
let from = head - SPAN;
const all = [];
while (from <= head) {
  const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
  try {
    const logsIn = await client.getLogs({ address: USDC, event: ev, args: { to: WALLET }, fromBlock: from, toBlock: to });
    const logsOut = await client.getLogs({ address: USDC, event: ev, args: { from: WALLET }, fromBlock: from, toBlock: to });
    all.push(...logsIn.map(l => ({...l, dir:'IN'})), ...logsOut.map(l => ({...l, dir:'OUT'})));
  } catch (e) {
    console.error('chunk fail', from, to, String(e).slice(0,120));
  }
  from = to + 1n;
}
console.log('\ntransfers found:', all.length);
for (const l of all) {
  const b = await client.getBlock({ blockNumber: l.blockNumber });
  console.log([
    l.dir,
    new Date(Number(b.timestamp) * 1000).toISOString(),
    'blk=' + l.blockNumber,
    'amt=' + formatUnits(l.args.value, 6),
    'from=' + l.args.from,
    'to=' + l.args.to,
    'tx=' + l.transactionHash,
  ].join('  '));
}
