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

We hold no user accounts. The payout (RECEIVE) wallet is **receive-only** — an
EIP-3009 authorization pins `to` = `X402_PAY_TO`, so a replayer can only push the
payer's own $0.02 toward us, and no private key for it exists in this codebase or
environment.

**This changed on 2026-08-21: autonomous spend is now authorized on the SPEND
wallet** (`0x2E31f337…`). Until then this section said we held no secret with
spend authority, and every judgement below inherited that. We do now. Breach
damage is no longer bounded by "there is nothing to take" — it is bounded by the
SPEND wallet's balance, which is a number someone chooses and must keep choosing
deliberately. See §9.

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
4. **Confidentiality** — was "least important; we hold little worth stealing."
   That is now only true of user data. A credential with spend authority is worth
   stealing, so confidentiality of the SPEND signer specifically ranks with the
   items above it, while everything else here still holds.

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
- **IPv6 /64 not normalised — the free tier and rate limit were optional for any
  IPv6 caller.** Both counters keyed on the full client address. IPv6's smallest
  routed allocation is a /64, which any VPS or home line controls in full, so a
  caller binding a new source address per request presented up to 2^64 identities
  — each a fresh 10-call tier and a fresh 60/minute window — without forging
  anything. `clientKey` (src/clientKey.ts) now collapses IPv6 to its /64 while
  leaving IPv4 exact, which makes the two families behave alike rather than
  making IPv6 stricter: an IPv4 household behind NAT has always shared one
  bucket. Normalised once in `clientIpOf`, so the free tier, the throttle and the
  ledger cannot drift into disagreeing about who a client is.
  _Proven end to end, not argued: with the tier set to 2, four calls from four
  different addresses inside one /64 went free, free, free-degraded,
  free-degraded — the counter depleting across the rotation — while a fifth call
  from a different /64 got its own tier._
  **One-time migration effect, checked rather than assumed:** `free-tier.json`
  keys are a salted hash of the client identifier, so counts written before the
  change key on the full address and stopped matching at the boundary. Any IPv6
  client mid-window got one fresh tier. That is the over-granting direction,
  which is `freeTier.ts`'s stated safe failure, and the orphaned entries are not
  a leak: `initFreeTier` calls `prune()` on every boot and drops anything past
  the 30-day window, so they clear themselves. Recorded so a later reader does
  not mistake the one-off for abuse.
  **Ledger semantics changed with it:** `client` is hashed from the same key, so
  unique/external client counts now treat a /64 as one client. Deliberate — a
  number answering "has a stranger used this" must not be inflatable by one
  stranger — and the accountant has been told rather than left to notice.
- **Metadata negative-cache poisoning** (per-result cache TTL). `getTokenMeta`,
  `getContractName`, and `getTokenSupply` returned `null` on any read failure and
  cached it FOREVER, so one transient RPC blip rendered a token's amounts at the
  18-decimal fallback (10^n wrong for stablecoins) for the whole process life.
  `TtlCache.getOrLoad` now accepts a per-result TTL; a `null` is cached for only
  `NEGATIVE_TTL` (10 min) and self-heals, while a real result is still kept long.
  The same mechanism has since closed the `verification.ts` / `firstTime.ts` /
  `drainers.ts` negatives (below).
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
  same way the logged `ipTag` is — same class as the ipTag item in Open #6, not new.)

- **One signed authorization could buy an unbounded number of decodes**
  (`src/authOnce.ts`). An EIP-3009 nonce is not consumed until SETTLE, and our
  path is verify → decode → settle. N concurrent requests carrying ONE
  authorization therefore all pass verify legitimately — the facilitator's
  simulation is a question about present chain state, and the honest answer to
  all N is yes — so each ran a full decode while exactly one settled. The revenue
  loss (N × $0.02) was never the point: each decode spends real upstream RPC
  calls, so one payment bought an unbounded multiple of our most expensive
  resource. Cost amplification, not a revenue bug, and only we could close it,
  because nothing is wrong on-chain until settle. Now single-flighted on
  `(payer, nonce)`: every caller of one authorization gets the SAME decode,
  computed once. The first call also BINDS the authorization to its transaction
  hash, and a later call on that authorization asking about a different hash is
  refused rather than answered — without that, a burst of one authorization plus
  N different hashes would have collapsed to one decode and returned it to
  callers who asked about other transactions, which is a silently wrong
  authoritative answer and worse than the cost bug being fixed. Caught in review
  by platform's question about key composition, before deploy. It DEDUPES rather than rejects on purpose — a client whose
  response was lost retries with the same authorization, and rejecting that
  after the first settled would take the money and withhold the decode, which is
  the one error this service must never make. Errors are not retained (a failed
  decode does not settle, so its authorization is still unspent). Fails open: an
  unreadable payload disables dedup rather than withholding work. Residual, by
  design: per-process, so multiple instances divide the amplification by instance
  count instead of eliminating it — the unbounded case is gone either way.
  NOT demonstrated against production, per the rules of engagement; code-level
  argument plus `test/auth-once.test.ts`.
- **A reverted transaction reported a phantom ETH movement** (`b1baeac`), and an
  **ERC-1155 batch truncated at 60 while claiming completeness** (`ceaabec`).
  Both made `assets_moved` assert something false — the first contradicted
  `status`, the `transaction_reverted` flag and the summary's own "no assets
  moved" inside one response.
- **Security-signal negative-cache poisoning** (`2d446d2`, `4ca22dc`, `ea44a8e`).
  `verification.ts` cached a transient `'unknown'` for a DAY keyed on address
  only, so one Sourcify blip suppressed `unverified_contract` for that contract
  for 24h across every client; `firstTime.ts` did the same with a `null` verdict.
  Live-exercised on 2026-08-20 by a 16-minute Blockscout outage that poisoned
  keys long after recovery. Both now use `NEGATIVE_TTL`. `drainers.ts`
  separately retried a failed blacklist load only after the full 12-hour refresh
  interval, leaving a fail-open check dark; it now retries in 60s, and concurrent
  cold-start callers all await the in-flight load instead of answering from an
  empty set.
- **A facilitator outage was a total outage** (`5d3c0bf`). `app.listen()` was
  gated behind `initPayments()`, so a PayAI blip at boot crash-looped the entire
  service — including the free tier and `/healthz`, which have nothing to do with
  payments. The port now binds first and payments initialize in the background
  with exponential backoff, registering the paid routes when they come up.
- **`fly deploy` shipped the WORKING DIRECTORY, not HEAD** (`e451b5e`, platform).
  With 3–4 sessions in one clone, a tree that COMPILES while carrying someone
  else's uncommitted changes shipped them silently — no commit, no review, and a
  deployed artifact corresponding to no inspectable commit. That voids the
  guarantee the whole review process rests on. Now gated by `scripts/predeploy.sh`.

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
2. **A paid request in flight during a deploy loses the payer's money. The loss
   is now VISIBLE but still NOT RECOVERABLE.**
   **Scope moved twice on 2026-08-21; both moves are stated rather than silently
   edited, so a later reader can see what changed.**
   _As first found:_ a $9 pass whose payment settled during a restart was
   destroyed silently. `activatePass(nonce)` resolves through `pendingByNonce`,
   an in-memory Map, and `PassEntry` carried no nonce, so `passes.json` could
   not express the mapping; `initPasses` then dropped every non-active entry at
   boot. Measured after a restart: `usePass` returned `invalid` (the token was
   GONE, not merely inactive), `listUnconfirmed()` was empty, nothing logged it.
   _Fixed the same night (visibility half only):_ the nonce is persisted,
   stranded entries are retained and marked instead of deleted, `usePass` now
   answers `not_activated`, `listUnconfirmed()` returns the entry WITH its
   nonce, and boot shouts the count and the action. Verified by booting the real
   module twice — the promise `docs/try-it.md` makes to a 3am debugger holds.
   **_What is still open, and it is the part that costs money:_ a stranded pass
   still cannot be activated.** The settlement hook died with the process, so
   nothing re-applies it. The payer's funds may have moved on chain with no pass
   issued, and recovery is currently a human comparing the payout wallet against
   `listUnconfirmed()` by hand. Until `authorizationState(payer, nonce)`
   reconciliation exists there is no automatic path back.
   The window is between mint (in the handler, post-verify) and `activatePass`
   (in `onAfterSettlement`).
   **CORRECTION, verified 2026-08-21 after platform checked the shutdown path:
   this is not a narrow race, it is a certainty for anything in flight.** There
   is NO graceful shutdown anywhere in the service — no `SIGINT` or `SIGTERM`
   handler exists (the only `server.close()` is per-request MCP transport
   cleanup inside `res.on('close')`), and `fly.toml` sets neither `kill_signal`
   nor `kill_timeout`. Fly sends SIGINT; Node with no listener exits
   immediately. So a deploy does not merely RISK interrupting an in-flight
   purchase — it kills every in-flight request instantly, with no drain. Every
   deploy tonight, and there were many, would have destroyed any request sitting
   between mint and settle.
   **And it is wider than the pass rail.** The same mechanism hits the $0.02
   per-call path, where settle also runs after the handler: a process death
   between broadcast and response means the payer's money moved and they
   received no decode. Smaller per event, but that is the rail our first
   interested customer has said they want, so it is the one most likely to be
   exercised first. If the process dies after
   the facilitator broadcast but before the hook, the transfer still completes
   on chain: the payout wallet receives $9 that our ledger never recorded and no
   pass exists for. That is worse than money-taken-no-service, because it is
   also money-taken-no-RECORD — the reconciler sees a wallet receipt it cannot
   attribute, and the customer holds a token string that answers `invalid`.
   Fix, in order of what matters: (a) stop dropping silently — retain pending
   entries at boot, log loudly, and surface them in `listUnconfirmed()` so a
   lost pass is discoverable at all; (b) persist the nonce on `PassEntry` so a
   restored pending pass can still be identified; (c) resolve it against
   `authorizationState(payer, nonce)` — the same on-chain ground truth already
   named below as the correct close for ambiguous activation, so these converge
   rather than compete. Visibility is the part worth doing before the first real
   $9 sale; the rest can follow.
   Operational note until fixed: do not deploy while a purchase could be in
   flight — but treat that as scaffolding, not a control. Verify-then-deploy is
   itself a race (a purchase can begin between the check and the machine
   stopping), and right now our only protection against losing a paid request is
   two agents remembering to look. Tonight established what happens to rules
   that live in memory. Fix order is in `docs/NEXT-STEPS.md`:
   `authorizationState(payer, nonce)` reconciliation FIRST, because it makes the
   loss recoverable and therefore makes deploy timing stop mattering; graceful
   shutdown second; retiring the verify-then-deploy ritual third, once the first
   two have engineered away its purpose rather than leaving a habit behind.
3. **Ambiguous pass activation (residual of the $9-pass fix in §4).** A pass activated
   because settlement was ambiguous rather than confirmed could, in principle,
   turn out to be unpaid — bounded at $9 of calls. Deliberately NOT capped: this
   path produced two serious bugs in one evening precisely because it accumulated
   conditional rules, and `listUnconfirmed()` makes every such pass queryable.
   The correct close is a reconciler against `authorizationState(payer, nonce)`
   (the same call verify uses) plus the payout wallet, not a cap that papers over
   it.
4. **UNVERIFIED: that the Stripe signing secret in Fly is the newly-ROLLED one.**
   The malformed entry whose NAME was a secret value is confirmed deleted, and a
   secret is loaded and verifying (an unsigned POST to `/stripe/webhook` returns
   400, not 503). But deleting that entry removed a COPY of the secret; it does
   nothing to the secret itself. If the value now in `STRIPE_WEBHOOK_SECRET` were
   still the exposed one, the exposure would be unchanged and only the evidence of
   it gone — which looks resolved and is worse. The founder states he rolled it in
   Stripe and pasted from the reveal field, and the digest changed, so the likely
   case is fine; that is testimony plus a weak signal, not proof, and the
   pre-rotation digest was never captured for comparison. No real webhook has been
   delivered since (app logs show only our own unsigned probe), so nothing has
   exercised it. Closes on the first real delivery, or a Stripe "send test event"
   — Stripe's dashboard was erroring when we tried. This also gates card payments
   working at all: a stale value means charged-at-Stripe, no pass minted.
5. **Test files are never typechecked**, so a signature change silently leaves
   stale callers. `tsconfig.json` includes only `src/**/*.ts`; `npm run typecheck`
   therefore passes while a test calls a function with the wrong shape. Found when
   adding a required field to `buildAssetsMoved` produced no error in
   `test/assets.test.ts` — the missing field became `undefined`, read as falsy,
   and the test kept passing while asserting the wrong behaviour. Given that both
   of the serious bugs on 2026-08-20 shipped with a green suite, a test that is
   quietly testing the wrong thing is worth closing. Fix: a `tsconfig.test.json`
   extending the base with `rootDir` at the project root and `include` covering
   `src` and `test`, wired to a `typecheck:test` script. Not done here: it touches
   shared build config and would surface errors across test files owned by several
   sessions, so it wants its own change rather than riding along with a bug fix.
6. **Info/ops:** `/healthz` publishes lifetime revenue + funnel unauthenticated;
   payer EIP-3009 signature written to logs on facilitator error; `ipTag` is a
   reversible 32-bit hash; unbounded usage-ledger Sets on a 256 MB box.

## 6. Checked and found safe (do not re-tread)

- **`Fly-Client-IP` spoofing** — Fly overwrites it; `ON_FLY` gates on
  `FLY_APP_NAME`, which Fly always sets.
- **Refund abuse for free _successful_ decodes** — `refundFreeCall` fires only
  when the call returned `isError`; you cannot get a real decode and a refund.
- **Facilitator outage _during verify_** — verify precedes the handler, so it
  fails closed (no free decode). The settle-after window leaked until the
  authorization single-flight closed it (§4).
- **Free decodes from an unfunded wallet** — does not exist. `verify` in
  `@x402/evm` is NOT signature-only: it runs `simulateEip3009TransferResult`
  against present chain state, so an authorization from a zero-balance wallet (or
  one whose nonce is already consumed) fails verify and never reaches the
  handler. This is load-bearing for how the paid path is reasoned about: the
  settle-after window leaks only what a payer who CAN pay is able to replay, not
  unlimited free service. Note the asymmetry — settle defaults to
  `simulateInSettle: false`, so it re-checks signature/expiry/value but does not
  re-simulate before broadcasting; an on-chain revert after broadcast is
  therefore still possible and is why `provablyUnpaid` requires an absent tx hash.
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
- **Any new revenue rail, or any change to what counts as a settled payment.**
  Check it against the invariant below before it ships, and tell the accountant
  session, whose books are only as honest as that definition.

  > REVENUE IS BOOKED ONLY FROM A CONFIRMED, LIVE, SETTLED PAYMENT, AND EVERY
  > SURFACE THAT DISPLAYS MONEY MUST DISTINGUISH ATTEMPTED FROM RECEIVED.

  This is written as an invariant because it has now been violated three times on
  three rails in about twelve hours, each time as a fresh bug rather than a
  recurrence: x402 booked revenue on an unconfirmed settle; `paid_calls` counted
  payment *attempts* and sat next to `revenue_usd` on a public endpoint, where two
  people who knew the system misread it as revenue and one nearly reported a first
  sale that had not happened; and the Stripe rail booked a real $9 row for a
  test-mode purchase. Each instance was fixed on its own. The pattern is that a
  new rail arrives without the rule, so state the rule rather than fixing a fourth
  instance. Note the reverse direction is deliberate and must stay: a pass
  activated on ambiguous settlement (`listUnconfirmed()`) is service delivered
  without confirmed payment, on purpose, because withholding from someone whose
  money probably moved is the worse error.
- **Any new request logging, access logging, or error reporting that includes a
  URL.** Pass tokens are carried in the MCP URL path (`/mcp/btxp_<48hex>`), a
  deliberate and documented weakening justified only because the worst case is
  metered calls. Today nothing logs a request path, so no token reaches our
  logs — that is an ABSENCE, not a control. Any code that logs a path must route
  it through `redactPassPath` (src/passUrl.ts), or every pass URL becomes a
  plaintext credential sitting in the log store for as long as logs are kept.
  Unverified and worth one check: whether Fly's edge logs request paths
  independently of the app, which no redaction of ours can reach.
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

## 9. Spend model (authorized 2026-08-21)

### 9a. Card spend — NEVER autonomous. Policy, and for the agents a hard limit.

Ads, tools and anything bought with a card are **proposed approvals**, not
autonomous spend. An agent prepares the case, names the cost, links the exact
page, explains what it buys — **and then stops.** The founder enters the card
details himself.

**An agent's work ends at the payment form.** No agent drives a browser through a
checkout on his behalf, even with his approval, and even when he has said yes to
the purchase. Approval to buy a thing is not approval to have card details typed
by a process that also reads attacker-authored text off a public blockchain.

Worth stating plainly so nobody treats this as a preference that could be traded
away under time pressure: **entering card numbers, bank details or credentials
into a form is something these agents will refuse to do regardless of
instruction.** It is a constraint they operate under, not a team agreement. Any
design that depends on an agent completing a checkout is not merely unwise, it
will not run.

This needs no key, no wallet, no on-chain scoping, and no signer. It is a
workflow. The security surface is the *proposal record*, not a credential — see
the reconciliation posture in the ledger, which becomes the ONLY evidence a card
payment was justified, since a card spend leaves no on-chain trace at all.

### 9b. Wallet security model (x402 only)

**RECEIVE wallet `0xd4ec730a…` — confirmed hardened, nothing to build.** EOA,
nonce 0. No private key for it exists in the codebase or environment; the exact
scheme pins the destination so payments can only push toward it; there is no
automated outbound path. The residual is founder key custody, which is not an
engineering problem. The only deliverable is detection (below).

**SPEND wallet `0x2E31f337…` — the real exposure.** EOA, nonce 0, and the
balance IS the blast radius.

Settled decisions:

- **Balance is the PRIMARY control, not a supplement.** Every software limit can
  be wrong about itself; none can spend money that is not there. Fund to roughly
  one period's expected spend, top up deliberately. The balance is now a security
  boundary, not just working capital.
- **Zero ETH is NOT a control.** It looks like one — no gas, so the wallet cannot
  move. But EIP-3009 lets any third party submit a signed authorization and pay
  the gas themselves, which is exactly why both our wallets show nonce 0 while
  holding funds. Zero ETH shapes a theft; it does not prevent one. Do not record
  it as a protection. This is proven here, not inferred: 0.02 USDC demonstrably
  LEFT the SPEND wallet while its nonce is still 0. Money has moved in both
  directions across two wallets that have never sent a transaction — and that
  mechanism is the one this product exists to explain, which makes writing zero
  ETH down as protection a particularly bad look.
- **HARD RULE — no closed loop.** A spending agent must NEVER consume this
  product's own `explain_transaction` output as decision input. We ingest
  attacker-controlled strings off a public chain (forged events, hostile token
  names — "BUY FLASH USDT" is the live example), so that wiring runs
  attacker-controlled data straight into our own spend decision, in one hop, with
  no key theft required. This outranks every mechanism below it.
- **Separate the signer from the parser.** Whatever holds signing capability must
  not be the process that ingests untrusted chain data.
- **`scripts/paid-call.ts` is a working signer already in the repo.** It reads
  `X402_TEST_PRIVATE_KEY` and signs with viem. It is a developer script, the
  variable is unset, and nothing the server runs imports it — so it is not a live
  exposure. It is a *footgun*: it is the nearest thing to reach for if someone
  builds autonomous spend under time pressure, and copying it yields exactly the
  design this section exists to prevent — a raw private key in an environment
  variable, in-process with everything else. If you are here because you are
  implementing spend, do not start from that file.
- **Detection: balance and ERC-20 Transfer events, NEVER transaction count.**
  Transaction-based monitoring is blind on this rail by construction — a drain via
  a signed authorization leaves the wallet's nonce at 0 and puts no transaction
  "from" it. Alert on any SPEND outflow without a matching logged expense, and on
  ANY RECEIVE outflow at all.
- **The honest framing, for anyone asked to promise more:** compromise cannot be
  made impossible. The maximum loss is a number we choose — the balance — and any
  loss should be visible in minutes. Nobody should sign their name to "completely
  secure."

**RESOLVED 2026-08-21:** ads and tools are CARD (§9a). For x402, the founder's
answer was conditional: *"if any agent finds an x402 service that requires company
spend to grow, then yeah."*

Read that precisely, because the design follows from the grammar. It is an
IF/THEN, not a present requirement. **No third-party x402 service has been named.**
So:

- **TODAY: pin `to` to our own payTo.** There is nothing else to pay, so pinning
  costs exactly nothing and buys near-total mitigation — a fully compromised
  agent can do nothing but pay us, which is a no-op. Build this. Do not build an
  unconstrained signer against a service nobody has identified.
- **TRIGGER TO EXPAND:** an agent identifies a SPECIFIC x402 service that requires
  spend to grow. That named payee is then approved and added. Caps and balance
  apply as the backstop.

**Checked, not merely unnamed (2026-08-21).** Growth looked and found no x402
vendor worth paying: the ones with verified evidence are either free and keyless
(GoPlus, Blockscout — both verified responding live) or direct competitors selling
into our buyer, where paying them funds a competitor's traffic. No vendor was
identified that would materially improve our own product. That is a real negative
result rather than an absence of effort, so the pinned default is the ANSWER, not
a placeholder awaiting research. Re-open only on a specific vendor with a price
and a reason, not on a hunch that one must exist.

**Forward note, since those free APIs were surfaced as candidates:** free does not
mean safe to consume. Wiring a third-party token-security verdict (GoPlus or
similar) into `risk_flags` would make our safety signal depend on their
correctness and availability, and would add another attacker-influenceable input
to output that other agents act on. That is a §7 re-review trigger (new upstream
dependency AND new attacker-controlled data reaching output), not a drop-in.

**His answer IS the allowlist**, arrived at from the product side rather than
imposed as a security constraint — "an agent finds a service, then we pay it"
describes a payee being named before it is paid. Nobody had to narrow his scope;
the scope was already shaped that way. Worth noting because it also means the
allowlist-versus-caps question does not need re-asking: caps remain the backstop,
the allowlist is simply how his conditional gets exercised.

**One approval model across both rails**, which is worth keeping deliberately: an
agent proposes, a human approves, then it executes. On card the human enters the
details (§9a); on x402 the human approves the payee once and it is then automatic
within caps. Same shape, simpler to reason about and to build than two models.

**The risk that is specific to this answer, and it is the crux.** The payee is
chosen by the agent, and the agent's inputs are attacker-reachable. A manipulated
agent paying an ATTACKER'S x402 endpoint is indistinguishable from normal
operation at every protocol level: well-formed transaction, valid signature,
legitimate-looking service, correct amount. There is no anomaly to detect. So
prevention cannot rest on spotting a "bad" payment, and detection cannot either —
it must be RECONCILIATION: every outflow matched to a pre-justified, logged
expense, alerting on anything unmatched rather than anything suspicious.

**CONTROLS BEFORE CAPABILITY — the sequencing rule, and the most important line
here.** As of today the $20 is NOT at risk: no key that can move it exists on the
server or within any agent's reach (Fly holds only STATS_TOKEN, the CDP keys,
STRIPE_WEBHOOK_SECRET, INTERNAL_MARKER; `X402_TEST_PRIVATE_KEY` appears only in
`scripts/paid-call.ts` and is unset). The balance becomes the blast radius at the
moment a signer is wired, not before. So: do not put a spending key anywhere an
agent can reach until the caps below are enforced. If a signer must be wired
first, draw the wallet down first instead.

Mechanism, given an unconstrained destination:

- **Caps are now the control, because `to` cannot be.** Scoped signer (smart
  account + session key; viable here via ERC-1271/6492) enforcing USDC-only, a
  per-transaction cap, and a per-period cap — on-chain, so they hold when the
  agent does not. Sizing: typical x402 calls run $0.02–$9, so a ~$1 per-tx and
  ~$5 per-day ceiling keeps a fully-owned agent's daily damage small against a
  $20 balance.
- **Balance stays the primary control** and is now 4x what it was ($4.98 → $20.00,
  funded in one transfer on 2026-08-21). Whatever limit gets built must hold
  against the WHOLE balance being at risk from day one, not a token amount.
- **A destination allowlist is worth proposing even though "anything" is in
  scope.** "Anything endpoint" as a PRODUCT goal does not require "anything
  endpoint" as a SIGNING permission. The set of x402 services actually worth
  paying is small; let the agent discover and propose, have a human approve a new
  payee once, then automate. That converts the strongest attack — pay the
  attacker — from an undetectable success into a blocked transaction, and it is
  dramatically stronger than caps alone. Worth putting to the founder as a
  product question, not deciding unilaterally on security grounds.

## 8. Notes for whoever deploys

`fly deploy` from the repo root — and note it builds the WORKING DIRECTORY, not
HEAD, so verify `git status --porcelain -- src package.json tsconfig.json
package-lock.json` is empty first or you may ship another session's uncommitted
work. `scripts/predeploy.sh` now enforces this; do not bypass it. Also confirm
your commit is not already live
(`git merge-base --is-ancestor <commit> HEAD`) before restarting a service real
users are mid-session on. After: confirm `/healthz` still shows the
lifetime ledger (it survives restarts via the `/data` volume) and that the 402
body still carries `accepts` + the `bazaar` extension (discovery crawlers read
it). A broken deploy is visible to real outside users now.
