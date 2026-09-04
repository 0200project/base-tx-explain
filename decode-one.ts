import { explainTransaction } from './src/explain.js';
const h = process.argv[2];
const r: any = await explainTransaction(h);
console.log(JSON.stringify({
  hash: h, action_type: r.action_type, summary: r.summary, status: r.status,
  assets_moved: r.assets_moved, risk_flags: r.risk_flags,
}, null, 1));
