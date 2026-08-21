/**
 * One-off: re-decode the playground's stored sample transactions directly
 * against the explainer (no HTTP, no paywall) to pick up new response
 * fields (e.g. `checks`) without fabricating historical data.
 */
import { explainTransaction } from '../src/explain.js';

const HASHES = [
  '0x0c84b951051f779903b57af9225ca570c77cd5531195968dd78106a69d6c4d8c',
  '0x8b246d458fd8b982455cdc172613272a090d1f84da559feb3392c152a09721c8',
  '0x8f1e67833a72c7d2d82ff57731fefaf96fa17bdecb9da7f9ac3f4c6b5679fa12',
  '0x08d78d805d54d3bface91a2f8d081d79429279bdd5a2f8c10da2b833dd3e0100',
  '0x3002b2c60d153e11e69986103b42d4887da30f8e02890f834d6de16e0c358be3',
];

(async () => {
  const out: Record<string, unknown> = {};
  for (const h of HASHES) {
    try {
      out[h] = await explainTransaction(h);
    } catch (e) {
      out[h] = { __error: String(e) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
})();
