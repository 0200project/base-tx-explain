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
- [ ] Apify console steps: the actor is PUSHED AND BUILT (id gcj5xAJ0vpAx8Uf2s,
      https://console.apify.com/actors/gcj5xAJ0vpAx8Uf2s) — remaining: enable
      Standby mode, set monetization, publish to the Store.
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

## Notes / cautions

- `ETHERSCAN_API_KEY` is optional. Etherscan's free tier no longer covers Base account
  endpoints (paid-only since late 2025); contract-verification endpoints still work
  free. The code already prefers Blockscout (keyless) for history and degrades
  silently — nothing breaks without the key.
- ScamSniffer's blocklist is GPL-3.0: consumed at runtime, deliberately never bundled
  into the repo. Keep it that way.
- The validation harness (`npm run validate`) hits public RPCs hard; a few
  `upstream_error` grades under load are normal and retry cleanly in real traffic.
