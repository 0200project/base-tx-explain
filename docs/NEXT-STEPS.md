# Morning checklist — what only you can do

The code is done, validated against 100 live transactions (95/100 clean decode, 0 crashes,
fresh run 2026-08-20), and both payment modes are tested end-to-end. Everything below needs
your identity, accounts, or wallet — none of it is code. Rough total: 60–90 minutes.

## Founder queue (updated 2026-08-20)

Done: GitHub org + push; site live at https://0200project.github.io; Fly x402 rail live
at https://base-tx-explain.fly.dev/mcp; MCP registry published 2026-08-20 as
io.github.0200project/base-tx-explain and republished at 0.1.1 the same day (enriched
metadata: website, repo, icon); GitHub repo topics added.

Open:

- [ ] Post the launch drafts (section 6 below) — the highest-value remaining item.
      Checked 2026-08-20: no Reddit account is logged into Chrome and only the
      PERSONAL X account is — the pseudonymous accounts (u/polaris28, X handle)
      must be created/logged in by you first; never post 0200project content
      from the personal account.
- [x] Apify Store: LIVE 2026-08-20 at https://apify.com/0200project/base-tx-explain
      (standby MCP mode, build 0.1.4). Published unmonetized: Apify discontinued
      rental pricing; pay-per-event needs Actor.charge() code plus a 14-day
      activation window. Decide later whether PPE is worth the build.
- [ ] Apify console: flip monetization to Pay per event, add event
      `explain-transaction` at $0.02 (decided; parity with x402), fill payout/
      billing details. Submitting starts the 14-day notice — billing begins
      ~Sept 3. Price is sticky once set (Apify cooldown between changes).
- [ ] Google Search Console: submit https://0200project.github.io (URL-prefix verify,
      needs your Google login); re-verify via DNS once 0200project.com lands. The SEO
      groundwork (sitemap, FAQ, structured data) is live and waiting on this.
- [ ] Run `npm run growth` (leads) and `npm run report` (daily numbers) each morning,
      or schedule via cron (see docs/growth-assistant.md)

Submitted, in review (no action unless comments arrive):

- x402 ecosystem listing: https://github.com/coinbase/x402/pull/292 (open)
- awesome-mcp-servers listing: https://github.com/punkpeye/awesome-mcp-servers/pull/12553
  (open, agent fast-track)

Blocked (not on you): **Coinbase Bazaar indexing** — CDP's facilitator rejects the
payment payloads our @x402/core 2.23 emits (400 "must match one of x402V2Pay...");
the same payloads settle fine on the keyless facilitator. A paid call does NOT fix
this — one was tried through the CDP path 2026-08-20 and failed, and the server was
reverted to keyless-first (X402_PREFER_CDP=1 flips it back for retesting). Needs a
payload-format diagnosis (suspects: @x402 2.21 vs 2.23 version skew, or the echoed
bazaar extensions block failing CDP's stricter schema) before it's worth retrying.

## 1. Payout wallet (5 min) — BEFORE anything else

Create a **fresh** wallet (Rabby / Coinbase Wallet / any EVM wallet). It only ever
*receives* USDC on Base — its key never touches the server. Put the address in `.env`
as `X402_PAY_TO`. Never reuse a personal wallet; the whole point is a clean pseudonymous
payout path.

## 2. GitHub org + push (10 min) [DONE 2026-08-20: repo and site are live]

Branding research (collision-checked): keep the tool name **base-tx-explain**, publish
everything under the handle **0200project** (GitHub org + npm scope were both free as of
2026-08-19; re-check at signup). Local git identity is already set to 0200project.

```bash
# after creating the org and an empty repo named base-tx-explain
cd ~/Projects/base-tx-explain
git remote add origin git@github.com:0200project/base-tx-explain.git
git push -u origin main
```

Use a fresh GitHub account or the org boundary — do not push from a personal account
if you want the pseudonym clean.

## 3. Apify (20 min) — marketplace-hosted build, their billing

`.actor/actor.json` + `.actor/Dockerfile` are ready (standby mode, `/mcp` path,
`ACTOR_WEB_SERVER_PORT` handled, readiness probe answered).

```bash
npm i -g apify-cli
apify login          # new pseudonymous Apify account
apify push
```

Then in the Apify console: enable Standby, set monetization (monthly rental — the
plan's $9/mo tier — or pay-per-event if you prefer usage pricing), publish to the Store.
Marketplace deploys run `PAYMENT_MODE=none` (the Dockerfile sets it): Apify bills, we
don't double-charge.

Your hosted MCP URL will be `https://<username>--base-tx-explain.apify.actor/mcp`.

## 4. x402 rail (15 min) — the agent-native deploy [DONE: live on Fly at base-tx-explain.fly.dev]

Any Docker host works (Fly.io, Railway, a $5 VPS — keep inside the $25/mo infra cap).

```bash
PAYMENT_MODE=x402 X402_PAY_TO=0x<your fresh wallet> node dist/index.js
```

Default facilitator is PayAI (keyless, verified live on Base mainnet). Alternative:
Coinbase CDP facilitator — needs free CDP API keys; those keys carry **no spend
exposure** (facilitators are non-custodial; they can't move or redirect funds), which
stays inside the hard rails. First 1,000 settlements/month free, then $0.001 each.

Smoke test after deploy: call the tool once unpaid (should decode free), 10 more times
(11th should return the x402 payment-required JSON). Then one real paid call from a
second wallet — I can't make payments, so this verification is yours.

## 5. Listings (20 min)

- **Official MCP registry** [DONE 2026-08-20: published as
  io.github.0200project/base-tx-explain; republished at 0.1.1 with enriched metadata]:
  `brew install mcp-publisher`, edit `server.json` (replace
  the placeholder URL with the live host), `mcp-publisher login github` (the 0200project
  account), `mcp-publisher publish`. The `io.github.0200project/*` namespace binds to
  that GitHub login.
- **x402 ecosystem page**: PR to the x402 repo — `app/ecosystem/partners-data/
  base-tx-explain/metadata.json` (name, description, websiteUrl, category
  "Services/Endpoints") + logo. Review ~5 business days.
- **x402 Bazaar**: BLOCKED as of 2026-08-20 — indexing requires a CDP-settled payment
  and CDP's facilitator 400s our payment payloads (see the Blocked note at the top).
  The Bazaar discovery extension stays in our responses so indexing starts working the
  moment the incompatibility is resolved. x402scan still picks up on-chain settlements
  automatically once real payments flow (unaffected — it reads the chain, not CDP).
- **MCPize**: thinner/less verifiable platform per research — try `npx mcpize init` +
  `deploy` only if it takes <15 minutes; don't sink time here.
- **Smithery**: optional; hosted streamable-HTTP listing, low effort, do it last.

## 6. Posts (20 min) — drafts ready in `docs/launch-posts.md`

Order matters (per channel-norms research): r/mcp first (showcase flair, disclosure),
X thread the same day (tag the x402 scene accounts — that's where amplification
actually comes from), community MCP Discord show-and-tell. r/modelcontextprotocol
24–48h later, reworded. **Skip r/LocalLLaMA entirely** (crypto-paid cloud tool = ban
bait) and never pitch in the official MCP contributor Discord.

## 7. Success tracking

Signal: any stranger's paid call (watch USDC arrivals at the payout address on
Basescan, or x402scan). Target: +$25 cumulative. Per the plan: zero paid calls by
day 14 → ship xrpl-intel in this same wrapper and rails, don't iterate this one.

**Gate caveat (decided 2026-08-20): judge the day-14 gate on the x402 rail and
usage signals only.** Apify pay-per-event billing carries a mandatory 14-day
notice period, so it cannot produce a single cent before ~Sept 3 no matter how
well the listing performs — an Apify $0 at gate time is structural, not a
failed channel. Usage signals that DO count: unique strangers, free-tier burn,
wall hits, and Apify listing runs.

## Notes / cautions

- `ETHERSCAN_API_KEY` is optional. Etherscan's free tier no longer covers Base account
  endpoints (paid-only since late 2025); contract-verification endpoints still work
  free. The code already prefers Blockscout (keyless) for history and degrades
  silently — nothing breaks without the key.
- ScamSniffer's blocklist is GPL-3.0: consumed at runtime, deliberately never bundled
  into the repo. Keep it that way.
- The validation harness (`npm run validate`) hits public RPCs hard; a few
  `upstream_error` grades under load are normal and retry cleanly in real traffic.

---

## FIRST THING TOMORROW — losing a PAID REQUEST to a deploy

_Written 2026-08-21 by Platform and Security jointly, at the end of a long night,
deliberately NOT built while tired. This is the top open item on the pass rail._

**Scope correction, 2026-08-21, and the heading above used to say "pass rail".**
Security widened it and it is right: **both paid rails have this shape**, not
just the $9 pass. Verified — the $0.02 per-call settle is recorded in
`onAfterSettlement` (`index.ts:291`), which runs AFTER the handler, so a process
death between the facilitator broadcast and that hook means the payer's money
moved and they received no decode and we recorded nothing.

Smaller per event than $9, and **more likely to be the one exercised first**:
the one genuinely interested party found so far has said per-call beats the
subscription for their volume. "Small per event" is exactly how a first
customer's only experience gets discounted.

My original heading scoped this to the pass rail, which would have led whoever
picks it up tomorrow to fix half of it. That is the same stale-statement shape
this file records elsewhere, committed inside the writeup of it.

**The problem.** A pass purchase is minted pending in the request handler and
activated in the settlement hook. If the process dies between those two points,
the facilitator has already broadcast, so **the transfer still completes on
chain**: $9 arrives in the payout wallet with no pass, nothing in the ledger, and
a customer holding a token. Tonight's work made that loss *discoverable* — the
entry is retained, marked stranded, listed in `listUnconfirmed()` with its nonce,
and shouted at boot — but it did not make it *recoverable*, and it did not stop
it happening.

**Today's protection is two agents remembering to check before deploying.** We
spent the same night establishing exactly what happens to rules that live in
memory. It is scaffolding, not a fix.

### Three things, in the order they matter

**1. `authorizationState(payer, nonce)` reconciliation.** The real close, and it
covers both rails: an authorization consumed on chain with nothing recorded on
our side is the same question whether it bought a pass or a single decode. A
stranded pass carries its nonce; ask the chain whether that authorization was
consumed. If it was, the customer paid — activate the pass and book the
settlement. If it was not, no money moved and the entry can be dropped. This
makes the loss *recoverable* and therefore makes deploy timing stop mattering,
which is why it comes first. It also closes the ambiguous-activation item
already in `security.md`; they converge rather than compete, so build one
mechanism.

**2. There is NO GRACEFUL SHUTDOWN, and this is wider than we said.** Verified
2026-08-21: `src/index.ts` has no `process.on('SIGINT'|'SIGTERM')` handler at
all. Fly sends **SIGINT** on every deploy and Node's default is to exit
immediately, so in-flight requests are killed rather than drained — including a
request sitting between mint and settle. The window is not "a purchase might
start while we deploy"; it is "any purchase in progress when we deploy dies."
Stop accepting connections, let in-flight requests finish, then exit. Small and
well understood — and it is the shutdown path, which is where the last
cheap-and-correct-at-4am change produced the boot-gate bug, so it wants someone
rested.

**3. Verify-then-deploy is a race, not a guarantee.** Checking that nothing is in
flight before shipping narrows the window; it does not close it, because a
purchase can begin between the check and the machine stopping. Worth doing until
(1) and (2) land. Worth retiring afterwards, rather than keeping a ritual whose
purpose has been engineered away.

### Two known artifacts, needing a decision rather than code

- **Two active passes are ours**, minted during the overnight build on
  2026-08-21 (05:21 and 06:11 UTC, no payer, no settlement). They show in
  `active_passes`, where they read as two customers holding passes. Revoke, or
  mark them internal the way settlements now are. Founder's call.
- **The Circadian probe settlement has no `id`**, so it can never be promoted.
  That is correct — an arrival nobody can name is one nobody can vouch for — and
  it now resolves into `known_non_revenue` rather than sitting in `unattributed`
  forever. Nothing to do; recorded so nobody re-discovers it as a bug.
