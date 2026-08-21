# Security model

The durable security reference for `base-tx-explain`. Sessions end; this file is
what the next one reads. It records the threat model, the trust boundaries, what
has been checked and found safe, and what is known-open — so nobody re-treads
old ground or reopens a closed question.

Keep it current: when a finding is fixed, move it from **Open** to **Fixed**
with the commit; when you clear a hypothesis, add it to **Checked and safe**.

_Last reviewed: 2026-08-21, live at `be8a858` (pass settlement integrity)._

---

## 1. What we are actually defending

We hold no user accounts, no secrets with spend authority, and the payout wallet
is **receive-only** (an EIP-3009 authorization pins `to` = `X402_PAY_TO`, so a
replayer can only push the payer's own $0.02 to us). Classic breach damage is
therefore bounded.

The asymmetric risk is **reputational and second-order**: our JSON is fed to
_other agents' LLMs_, which act on it. A wrong or manipulated answer can cost a
user money through an agent that trusted us — and that failure is invisible to
us, because it happens in someone else's system. **This is the thing to defend
hardest.** It is why a confidently-wrong or injectable decode is a security
issue, not merely a bug.

Priority order for security effort:

1. **Output integrity** — the decode must not confidently assert something false,
   and must not carry attacker-authored instructions into a consuming model.
2. **Revenue/paywall** — the free-tier and payment gates.
3. **Availability** — one 256 MB Fly machine serving real users.
4. **Confidentiality** — least important; we hold little worth stealing.

## 2. Trust boundaries

**Untrusted (attacker-controllable) — treat as data, never as truth or
instructions:**

- The transaction itself: any contract can emit any log and be called with any
  4-byte selector. Event `topic0` and function selectors are _claims_, not proof.
- Token/contract self-reported metadata: `symbol()`, `name()`, `decimals()`,
  `totalSupply()`. A token can name itself anything and lie about decimals.
- Third-party API responses that reach output: Sourcify ABIs (event names),
  `api.4byte.sourcify.dev` (function names — community-submittable), Blockscout
  txlist, the two GitHub scam blocklists.
- Any client-supplied HTTP header **except** `Fly-Client-IP` (see below), and the
  request body.

**Trusted:**

- Our own code and the static `src/labels.ts` address table (hand-verified).
- The Fly edge: it stamps `Fly-Client-IP` and overwrites any client-supplied
  value, so it is a safe identity key. `trust proxy` is `1` (one hop), so
  `req.ip` is not spoofable via `X-Forwarded-For`.
- The Chainlink ETH/USD feed and Base RPC for _consensus_ data (balances, logs,
  receipts) — but not for anything a contract self-reports.

**The output contract:** `provenance.untrusted_fields` on every result names the
fields whose strings are attacker-controlled (`summary`, `assets_moved[].token`,
`counterparties[].label`). Consuming agents are told, in-band, to treat those as
data. Keep that list honest as fields change.

## 3. Attack surface

- `POST /mcp` — the tool. Free-tier + rate-limit gate, x402 payment path, then
  the decoder fan-out (Base RPC, Sourcify, 4byte, Chainlink, Blockscout,
  blocklists).
- `GET /healthz`, `/stats`, `/openapi.json`, `/`, `/llms.txt` — info surface.
- The decoder → `summary`/`assets_moved`/`risk_flags` → **a downstream LLM.**
- Startup: `initPayments()` reaches the x402 facilitator before serving.
- Deploy pipeline: three sessions committing to one repo daily.

## 4. Fixed

- **Forged protocol events laundering a drain into a benign action** (classifier
  emitter-gating). `decodeKnownLog` matches on `topic0` alone, but `log.address`
  (the emitter) is _not_ forgeable — a contract can only emit logs from itself.
  `classify` now trusts a protocol-semantic event (Aave lending, OP bridge,
  Seaport sale, EAS attestation, Basenames registration) only when the emitter
  carries the matching label, so a counterfeit event from a random contract no
  longer produces "supplied to Aave" / "bridged into Base" / "claimed". A drain
  fronted by a `claim()` selector is also caught: the claim rule is now
  subordinate to net flows (a real claim receives value; a sender that only
  parted with value is described as the transfer it is). Real, labeled protocols
  are unaffected. Residuals in Open #1. _Recall cost measured, not assumed: a
  120-transaction sweep of live Base traffic after the change was 93.3% clean
  with 0 crashes, and every partial was an app-specific unrecognized-event
  contract or a batch transfer hitting the 60-asset display cap — none came from
  the emitter gating. The safety-over-recall trade cost no measurable coverage._
- **$9 pass issued without payment / phantom revenue** (`649c763`, `38bc986`,
  `be8a858`). `buy_pass` minted inside the x402 handler, which runs BEFORE
  settle, and @x402/mcp returns the handler's result even when settle answers
  `200 {success:false}` — a caller whose payment never landed received a live
  $9 bearer token, repeatably (an authorization can pass verify and fail settle;
  the EIP-3009 nonce is only consumed at settle). MCP passes now mint inert and
  activate only when settlement resolves; REST already withheld the token
  (@x402/express discards the buffered body on failed settle) so it mints active
  — minting pending there would have stranded real payers. Revenue is booked on
  both rails only once a sale is confirmed/delivered.
  **Two corrections found by adversarial verification, both worse than the
  original bug:** (1) the nonce was read from `extra._meta`, but the wrapper
  passes its own `{toolName, arguments, meta}` context — always null, so every
  paid pass would have been dead on arrival (100% failure on real sales). Now
  typed as the library's `MCPToolContext`, so that mistake is a build error.
  (2) revoking on `success===false` is WRONG: `settlement_pending` carries a real
  tx hash after broadcast and `transfer_event_mismatch` means the transfer mined.
  A pass is now taken back only on a provably pre-broadcast rejection (no tx hash
  + a recognised validation reason); everything else activates and alerts.
  _Design rule this established: on a payment path, ambiguity must fail toward
  the customer. "Withhold, maybe activate" looks safer than "grant, maybe
  revoke" but flips the ambiguous cases — where real payers sit — from fail-open
  to fail-closed._
- **Metadata negative-cache poisoning** (per-result cache TTL). `getTokenMeta`,
  `getContractName`, and `getTokenSupply` returned `null` on any read failure and
  cached it FOREVER, so one transient RPC blip rendered a token's amounts at the
  18-decimal fallback (10^n wrong for stablecoins) for the whole process life.
  `TtlCache.getOrLoad` now accepts a per-result TTL; a `null` is cached for only
  `NEGATIVE_TTL` (10 min) and self-heals, while a real result is still kept long.
  The same mechanism is available to close the `verification.ts` / `drainers.ts`
  negatives (Open #3).
- **Token-symbol impersonation** (canonical cross-check). A contract that
  self-reports a valid ticker (e.g. "USDC") from an address that is not that
  token's canonical one is shown as its address, not the ticker, and carries a
  distinct `impersonated_token` risk flag (separate from `nonstandard_token_symbol`,
  which is a merely non-standard symbol — the first is active deception, the
  second could be an honest quirk). **Bounded mitigation, not a closed class:**
  the catch is only as wide as the token label table (`src/labels.ts`). As of the
  label expansion it covers **19 tickers** (USDC, USDT, EURC, USDS, sUSDS, GHO,
  DAI, the ETH/BTC LSTs, etc.), up from 8 — a fake "USDT" now resolves to
  impersonation, but a ticker still absent from the table sails through until its
  canonical address is added. Every address was published by the issuer and read
  back on-chain before being trusted (`scripts/verify-labels.ts` rejected 14 of
  57 candidates); that bar is what makes widening the table safe, since a wrong
  entry would actively vouch for an impostor. Expanding the table widens this
  mitigation and improves decode quality at once — the table is the product's
  closest thing to a compounding asset. Unknown symbols are a deliberate allow
  (most tokens are legitimate and unlabeled).
- **Token-metadata prompt injection** (`cbe62d6`). Hostile token symbols/names
  and third-party event/function names reached `summary`. Now: `sanitizeSymbol`
  hardened (NFKC, strips control/format/line-separator/mark chars incl.
  U+2028/U+2029, drops emoji, allowlist + cap) and applied to the 4byte and
  Sourcify name paths; `displaySymbol` validates the **raw** symbol as a short
  ASCII ticker and shows the contract address otherwise (+ a factual
  `nonstandard_token_symbol` flag); a `provenance` block marks untrusted fields.
  Real fixture: token `0x5c371cc9121a71c974091e0eb07d05d02a6915a9`
  (`"BUY FLASH USDT"` with emoji).
- **`approve()` returned `risk_flags: []`** (`3a13cde`). Verification and
  first-time checks keyed on `to` (the token), skipping the spender. Now
  resolved per action (spender/operator, additively with `to`), spender named.
- **`unlimited_approval` evadable at 2^128 − 1** (`cbe62d6`). Now compares the
  allowance against the token `totalSupply` (cached), 2^128 as fallback.
- **XFF free-tier spoof / batched `tools/call`** (`51b7f3d`, pre-audit). `trust
  proxy: 1` + `Fly-Client-IP`; multi-call batches rejected.
- **Free-tier reset by every deploy** (`86d7f3f`). The free-call counter lived
  only in memory while the ledger persisted, so every restart handed every client
  a fresh 10 calls — at the multi-session deploy frequency no real user reached
  the paywall, making revenue structurally impossible. Counts now persist to the
  `/data` volume (salted-hash keys, 30-day window anchored to first call, atomic
  write, degrades to in-memory on file error — over-granting, never wrongly
  charging). Verified live: `/data/free-tier.json` initializes on boot. (Minor
  residual: the key salt is a constant prefix, so file keys are IP-reversible the
  same way the logged `ipTag` is — same class as the ipTag item in #7, not new.)

## 5. Open (known, unfixed) — ranked

1. **Residual spoofed-evidence: swap events.** The main forged-event vectors are
   closed (see Fixed: emitter-gating) and token-symbol impersonation is now a
   bounded mitigation (also Fixed). What remains, lower-severity: `univ3_swap`
   etc. are still trusted on the event alone — the emitter is the pool, which is
   not labeled, so emitter-gating does not apply. A bare forged Swap event
   mislabels as `swap` ("executed a token swap"); with the token-identity fix,
   forged token legs show as addresses. A swap is not a custody-safety claim, so
   this ranks below the closed cases. Candidate fix: require corroborating
   fungible movements before trusting a swap event.
2. **Reverted tx with value reports a phantom ETH movement**; ERC-1155 batch
   truncates at 60 with `truncated:false`. Both make `assets_moved` assert
   something false.
3. **Negative-cache poisoning of security signals — now live-exercised, and the
   fix is two one-liners.** `verification.ts:15` caches a transient `'unknown'`
   for a DAY, keyed on ADDRESS ONLY — so one Sourcify blip suppresses
   `unverified_contract` for that contract for 24h across every transaction and
   every client. `firstTime.ts:40` does the same with a `null` verdict (keyed
   including `beforeBlock`, so narrower impact). Base Blockscout returned HTTP
   500 at 22:04 on 2026-08-20 and 200 by 22:20 — a 16-minute outage that poisoned
   those keys for 24 hours, long after recovery. The `checks` field now makes the
   resulting degradation visible, which is a real improvement, but the poisoning
   itself is unchanged. The machinery to fix it already exists (per-result TTL in
   `TtlCache.getOrLoad`, plus `NEGATIVE_TTL`):
   - `verification.ts`: pass `(v) => (v === 'unknown' ? NEGATIVE_TTL : DAY)` as
     the `getOrLoad` TTL.
   - `firstTime.ts`: `cache.set(cacheKey, verdict, verdict === null ? NEGATIVE_TTL : DAY)`.
   Priority note: this is cheaper and closes more than the deferred
   truncated-vs-unreachable status split, which is a return-type change touching
   these same cache semantics. Do these first.
4. **Facilitator outage = total outage** — `app.listen()` is gated behind
   `initPayments()`; a PayAI blip at boot crash-loops the whole service. Bind
   first, init payments in the background.
5. **IPv6 /64 not normalized** — free-tier/rate-limit keyed on the full address;
   a routed /64 mints many tiers. Mask to /64. (Bounded by machine throughput;
   the real harm is upstream-quota exhaustion.)
6. **Ambiguous pass activation (residual of the fix below).** A pass activated
   because settlement was ambiguous rather than confirmed could, in principle,
   turn out to be unpaid — bounded at $9 of calls. Deliberately NOT capped: this
   path produced two serious bugs in one evening precisely because it accumulated
   conditional rules, and `listUnconfirmed()` makes every such pass queryable.
   The correct close is a reconciler against `authorizationState(payer, nonce)`
   (the same call verify uses) plus the payout wallet, not a cap that papers over
   it.
7. **Info/ops:** `/healthz` publishes lifetime revenue + funnel unauthenticated;
   payer EIP-3009 signature written to logs on facilitator error; `ipTag` is a
   reversible 32-bit hash; unbounded usage-ledger Sets on a 256 MB box.

## 6. Checked and found safe (do not re-tread)

- **`Fly-Client-IP` spoofing** — Fly overwrites it; `ON_FLY` gates on
  `FLY_APP_NAME`, which Fly always sets.
- **Refund abuse for free _successful_ decodes** — `refundFreeCall` fires only
  when the call returned `isError`; you cannot get a real decode and a refund.
- **Facilitator outage _during verify_** — verify precedes the handler, so it
  fails closed (no free decode). Only settle-after leaks (Open #7).
- **Non-string `tx_hash` crash** — the MCP SDK's zod layer rejects it (`-32602`)
  before `runExplain`. Confirmed live.
- **Malformed-JSON stack leak** — Express 5 under `NODE_ENV=production` returns a
  generic `Bad Request`, no stack. Confirmed live.
- **Prototype pollution via body** — `JSON.parse` makes `__proto__` an own
  property; not merged into any prototype in the MCP/x402 spread path.
- **JSON-envelope breakout in `summary`** — `JSON.stringify` escapes quotes; the
  only injection is _within_ the string value (that is the token-name vector,
  Fixed).
- **Script injection (XSS) via decoded output in the site playground** — the
  playground renders results with `innerHTML`, but every value goes through
  `esc()` (escapes `& < >`) in `renderVal`/`curlBlock`, and the `tx_hash` comes
  from a text input (not a URL param), also escaped. Belt-and-suspenders with the
  source-level `sanitizeSymbol` strip of `<>"'`. Re-check if any site page ever
  renders a decoded field without `esc()`.
- **Secrets in git / scripts / dashboard** — `.env`, `.stats-token`, `/data/`
  gitignored; history clean; `scripts/*` make only unauthenticated GETs and log
  no keys; the dashboard embeds no token. `X402_PAY_TO` in `fly.toml` is public
  by design in x402.
- **Caret dep ranges** — `package-lock.json` (v3) is committed and the Dockerfile
  uses `npm ci`, so builds are pinned.

## 7. Re-review triggers (not a schedule — volume is too low)

Re-run an adversarial pass, or at minimum read the diff with this file open, when
a change touches any of:

- **Payment path** — `initPayments`, the x402 wrapper, settlement hooks,
  `charge`/`hasPayment` logic, facilitator config. _(Do not reorder facilitators:
  keyless must stay first — the server does not fail over on rejection and
  CDP-first rejects real payments. Do not remove `@x402/svm`: imported
  unconditionally, its absence kills the process at module load.)_
- **Client identification / free tier** — `clientIpOf`, `freeTier.ts`, the rate
  limiter, anything keyed on the client.
- **New attacker-controlled data into output** — any new field sourced from
  on-chain data or a third-party API that reaches `summary`/`assets_moved`/
  `risk_flags`/`counterparties`. Add it to `provenance.untrusted_fields`.
- **A new upstream dependency** or a change to how an existing one's response is
  parsed.
- **`src/labels.ts` additions are trust assertions, not just display.** A labeled
  address makes `getLabel()` truthy, which (a) suppresses `unverified_contract`
  and `first_time_counterparty` against it in `risk/flags.ts`, and (b) makes it
  the canonical address for its ticker in the impersonation guard. A wrong entry
  actively vouches for a scam. Add an address only when it is verified from the
  issuer's official source AND cross-checked on-chain (symbol + decimals).
- **`src/index.ts`** (shared, high-traffic) — announce to the other sessions
  before editing; read the whole request path after.

Three sessions ship to this repo daily and nobody else reviews for security: a
trust-boundary change can arrive inside a commit whose message is about copy.
Watch the diffs, not just the commit subjects.

## 8. Notes for whoever deploys

`fly deploy` from the repo root. After: confirm `/healthz` still shows the
lifetime ledger (it survives restarts via the `/data` volume) and that the 402
body still carries `accepts` + the `bazaar` extension (discovery crawlers read
it). A broken deploy is visible to real outside users now.
