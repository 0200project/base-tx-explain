# Growth assistant (scripts/growth-scan.mjs)

A zero-dependency Node script that scans public, keyless sources for threads and
repos where base-tx-explain is genuinely relevant, and writes a daily
human-review brief. It reads; it never writes to any platform.

## What it does

- Fetches, sequentially with a 1s delay and an honest User-Agent:
  - Reddit new posts: r/mcp, r/modelcontextprotocol, r/AI_Agents, r/ethdev
  - HN (Algolia): "x402", "etherscan api", "mcp server monetize"
  - GitHub: x402 repo search (recently updated) and open PRs on coinbase/x402
  - npm: packages matching x402
  - Bluesky: posts matching x402
- Classifies matches into three angles: **tx-decode need** (highest intent),
  **monetization pattern**, **integration offer**. Items older than 48h are kept
  but flagged stale. Price-speculation posts (pump, moon, token price) are skipped.
- Appends new leads to `outreach/queue.jsonl`, writes a brief to
  `outreach/briefs/YYYY-MM-DD.md` with a quoted snippet and a 2-3 sentence draft
  stub per lead, and dedupes forever via `outreach/seen.json`.
- KPI lane (signals, never drafts): USDC arrivals at the payout address via
  Blockscout, plus MCP registry liveness. Totals accumulate across runs in
  `seen.json`, so run it regularly for an accurate ledger.

`outreach/` is gitignored. Drafts must never reach the public repo.

## The no-spam contract

- The script holds no credentials by construction. Every request is an
  unauthenticated GET. It cannot post, upvote, star, or DM.
- A human reads the actual thread, edits the stub to fit it, and posts manually
  from the right account. Stubs always carry the "I built this" disclosure and
  follow the launch-posts style: no emoji, no hype, no em-dashes.
- Pace: at most 1-2 replies per platform per day. Never reply twice in the same
  subreddit on the same day. Reply to a given thread at most once, ever
  (`seen.json` enforces the dedupe; do not clear it).
- After acting, mark the entry in `queue.jsonl` yourself (add
  `"status": "posted"` or `"status": "skipped"` to the line) so the queue stays
  an honest log.

## How to run

```bash
npm run growth
```

Runs in about 20-30 seconds (rate-limit delays dominate). Prints a summary:
new leads, stale count, KPI line. A failing source is skipped and noted; the
script never exits nonzero because one source was down. Reddit sometimes 403s
from datacenter IPs; from a home connection it usually works.

## Optional: run it daily on macOS

Add a crontab line (`crontab -e`); adjust the node path to `which node`:

```
15 9 * * * cd /Users/alejandrotrejo/Projects/base-tx-explain && /opt/homebrew/bin/node scripts/growth-scan.mjs >> outreach/cron.log 2>&1
```

Then check `outreach/briefs/` with your morning coffee. cron runs with a minimal
environment, which is why the line uses an absolute node path instead of npm.

## X and Discord caveat

Neither X nor Discord offers a keyless read API, so the script does not cover
them. They stay a manual daily check: X search for x402 and CoinbaseDev/x402
scene threads, and the community MCP Discord showcase channel. Same contract
applies: disclosure, edit per thread, low volume.
