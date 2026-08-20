# Security model

The durable security reference for `base-tx-explain`. Sessions end; this file is
what the next one reads. It records the threat model, the trust boundaries, what
has been checked and found safe, and what is known-open — so nobody re-treads
old ground or reopens a closed question.

Keep it current: when a finding is fixed, move it from **Open** to **Fixed**
with the commit; when you clear a hypothesis, add it to **Checked and safe**.

_Last reviewed: 2026-08-20, at commit `7ae1ff8` + the symbol-impersonation cross-check._

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
- **Token-symbol impersonation** (canonical cross-check). A contract that
  self-reports a valid ticker (e.g. "USDC") from an address that is not that
  token's canonical one is shown as its address, not the ticker, and carries a
  distinct `impersonated_token` risk flag (separate from `nonstandard_token_symbol`,
  which is a merely non-standard symbol — the first is active deception, the
  second could be an honest quirk). **Bounded mitigation, not a closed class:**
  the catch is only as wide as the token label table (`src/labels.ts`, ~8 tokens
  today). A fake "USDC" is caught; a fake "USDT" or "EURC" is not until that
  token's canonical address is added. Expanding the token label table widens this
  mitigation and improves decode quality at the same time — the table is the
  product's closest thing to a compounding asset. Unknown symbols are a
  deliberate allow (most tokens are legitimate and unlabeled).
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
2. **`decimals()` failure negative-cached FOREVER** — one bad read renders a
   token's amounts 10^n wrong for the process life. Don't cache transient nulls.
3. **Reverted tx with value reports a phantom ETH movement**; ERC-1155 batch
   truncates at 60 with `truncated:false`. Both make `assets_moved` assert
   something false.
4. **Negative-cache poisoning of security signals** — `verificationStatus`
   caches transient `unknown` for a day; `drainers.ts` disables `known_drainer`
   for 12 h after a failed cold start. Both silently drop a risk flag.
5. **Facilitator outage = total outage** — `app.listen()` is gated behind
   `initPayments()`; a PayAI blip at boot crash-loops the whole service. Bind
   first, init payments in the background.
6. **IPv6 /64 not normalized** — free-tier/rate-limit keyed on the full address;
   a routed /64 mints many tiers. Mask to /64. (Bounded by machine throughput;
   the real harm is upstream-quota exhaustion.)
7. **Phantom settlement** — a facilitator `200 {success:false}` still returns the
   decode and books $0.02. Gate `onAfterSettlement` on `settlement.success`.
8. **Info/ops:** `/healthz` publishes lifetime revenue + funnel unauthenticated;
   payer EIP-3009 signature written to logs on facilitator error; `ipTag` is a
   reversible 32-bit hash; unbounded usage-ledger Sets on a 256 MB box.
9. **Free-tier enforcement is reset by every deploy** (business-logic, not a
   security hole — nobody can _force_ a reset). The free-call counter lives only
   in memory (`freeTier.ts`) while the usage ledger persists to the volume, so a
   restart hands every client a fresh 10 free calls. At the current multi-session
   deploy frequency no real user reaches the paywall, so free-tier enforcement is
   much weaker than the code implies. The payments session owns the fix
   (persist/derive the counter); this line moves to Fixed when it lands or the
   founder decides to leave it. Compounds with #6.

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
