#!/usr/bin/env node
/**
 * growth-scan.mjs
 *
 * Read-only lead scanner for base-tx-explain. Scans public, keyless sources for
 * threads and repos where the tool is genuinely relevant, then writes a
 * human-review brief with draft reply stubs.
 *
 * Contract: this script NEVER posts anywhere. It holds no credentials by
 * construction (every request is an unauthenticated GET). A human reads the
 * brief, opens the thread, edits the stub, and posts manually from the right
 * account. See the private growth notes.
 *
 * Zero npm dependencies. Node 18+ (global fetch, AbortSignal.timeout).
 *
 * Outputs (all under outreach/, which is gitignored):
 *   outreach/queue.jsonl        append-only lead queue
 *   outreach/briefs/YYYY-MM-DD.md   the daily human-review brief
 *   outreach/seen.json          per-URL dedupe forever + tracked payments
 *
 * The script never exits nonzero because a single source failed.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTREACH_DIR = join(ROOT, "outreach");
const BRIEFS_DIR = join(OUTREACH_DIR, "briefs");
const SEEN_PATH = join(OUTREACH_DIR, "seen.json");
const QUEUE_PATH = join(OUTREACH_DIR, "queue.jsonl");

const USER_AGENT =
  "0200project-growth-scan/0.1 (github.com/0200project/base-tx-explain)";

// KPI lane constants
const PAY_TO = "0xc41c4fed450674169af002b8b3cb47bd70a1958f";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // native USDC on Base
const BLOCKSCOUT_URL = `https://base.blockscout.com/api/v2/addresses/${PAY_TO}/token-transfers?type=ERC-20&filter=to`;
const REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0/servers?search=base-tx-explain";

const NOW = Date.now();
const MS_48H = 48 * 60 * 60 * 1000;
const MS_7D = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Angle rules (case-insensitive substring match on title + body)
// ---------------------------------------------------------------------------

const ANGLE_DECODE = "tx-decode need"; // highest intent
const ANGLE_MONETIZE = "monetization pattern";
const ANGLE_INTEGRATE = "integration offer";

const DECODE_KEYWORDS = [
  "decode transaction",
  "parse receipt",
  "input data",
  "what did this transaction",
  "etherscan free tier",
  "etherscan pricing",
];

const MONETIZE_KEYWORDS = [
  "monetize",
  "paid mcp",
  "charge for tools",
  "x402",
  "payment per call",
];

// Price-speculation noise: skip entirely. Word boundaries so "moonbeam" or
// "pumpkin" do not trip the filter.
const SPECULATION_PATTERNS = [/\bpump\b/i, /\bmoon\b/i, /token price/i];

function hasAny(text, keywords) {
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

function isSpeculation(text) {
  return SPECULATION_PATTERNS.some((re) => re.test(text));
}

// Returns an angle string or null. Decode intent wins over monetization.
function classifyText(text) {
  if (hasAny(text, DECODE_KEYWORDS)) return ANGLE_DECODE;
  if (hasAny(text, MONETIZE_KEYWORDS)) return ANGLE_MONETIZE;
  return null;
}

// ---------------------------------------------------------------------------
// Draft reply stubs. Style contract from docs/launch-posts.md: disclosure line
// always, no emoji, no hype adjectives, no em-dashes. These are STUBS: the
// human edits them to fit the actual thread before posting.
// ---------------------------------------------------------------------------

const DRAFT_STUBS = {
  [ANGLE_DECODE]:
    "Disclosure: I built this. base-tx-explain is an MCP tool that takes a Base mainnet transaction hash and returns strict JSON: a plain-English summary, assets moved, labeled counterparties, risk flags, and gas in USD. The decode is deterministic with no LLM in the response path, and the first 10 calls are free if you want to test it against your case.",
  [ANGLE_MONETIZE]:
    "Disclosure: I built one of these. base-tx-explain charges $0.02 per call in USDC on Base via x402 after 10 free calls, with the 402 challenge delivered in-band so an agent can pay and retry without an account or API key. Happy to share the wiring details if that would help here.",
  [ANGLE_INTEGRATE]:
    "Disclosure: I built a paid MCP server that uses x402 (base-tx-explain, $0.02 per call in USDC on Base, 10 free calls first). If a live x402 seller endpoint is useful for testing your project, it is public and needs no account. Open to feedback in either direction.",
};

// ---------------------------------------------------------------------------
// Fetch plumbing: sequential, 1s delay between requests, honest User-Agent,
// 20s timeout. Every caller wraps in try/catch; a failed source is skipped.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requestCount = 0;

async function fetchJson(url, extraHeaders = {}) {
  if (requestCount > 0) await sleep(1000);
  requestCount += 1;
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// State (outreach/seen.json): { urls: { url: firstSeenISO }, payments: { txHash: { amount, ts } } }
// ---------------------------------------------------------------------------

function loadSeen() {
  try {
    const raw = JSON.parse(readFileSync(SEEN_PATH, "utf8"));
    return {
      urls: raw.urls && typeof raw.urls === "object" ? raw.urls : {},
      payments:
        raw.payments && typeof raw.payments === "object" ? raw.payments : {},
    };
  } catch {
    return { urls: {}, payments: {} };
  }
}

function makeSnippet(s) {
  const t = (s || "")
    .replace(/<[^>]+>/g, " ") // HN Algolia bodies carry HTML tags
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 280 ? t.slice(0, 277) + "..." : t;
}

// ---------------------------------------------------------------------------
// Collectors. Each returns raw candidates: { source, url, title, body, dateMs, forcedAngle? }
// ---------------------------------------------------------------------------

const sourceErrors = [];

function noteError(source, err) {
  sourceErrors.push(`${source}: ${err.message || err}`);
}

async function collectReddit() {
  const subs = ["mcp", "modelcontextprotocol", "AI_Agents", "ethdev"];
  const out = [];
  for (const sub of subs) {
    const src = `reddit r/${sub}`;
    try {
      const data = await fetchJson(
        `https://www.reddit.com/r/${sub}/new.json?limit=25`
      );
      const children = data?.data?.children || [];
      for (const c of children) {
        const d = c?.data;
        if (!d) continue;
        out.push({
          source: src,
          url: `https://www.reddit.com${d.permalink}`,
          title: d.title || "",
          body: d.selftext || "",
          dateMs: d.created_utc ? d.created_utc * 1000 : null,
        });
      }
    } catch (err) {
      // Reddit 403s from datacenter IPs are expected sometimes; skip quietly.
      noteError(src, err);
    }
  }
  return out;
}

async function collectHackerNews() {
  const queries = ["x402", "etherscan api", "mcp server monetize"];
  const out = [];
  for (const q of queries) {
    const src = `hn "${q}"`;
    try {
      const data = await fetchJson(
        `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)`
      );
      for (const hit of data?.hits || []) {
        out.push({
          source: src,
          url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          title: hit.title || hit.story_title || "",
          body: hit.story_text || hit.comment_text || "",
          dateMs: hit.created_at ? Date.parse(hit.created_at) : null,
        });
      }
    } catch (err) {
      noteError(src, err);
    }
  }
  return out;
}

async function collectGitHub() {
  const out = [];
  // One search request per run keeps us far under the unauthenticated limit
  // of 10 search requests per minute.
  try {
    const data = await fetchJson(
      "https://api.github.com/search/repositories?q=x402&sort=updated&per_page=10",
      { Accept: "application/vnd.github+json" }
    );
    for (const repo of data?.items || []) {
      const dateMs = Date.parse(repo.pushed_at || repo.updated_at || "") || null;
      const fresh = dateMs && NOW - dateMs <= MS_7D;
      out.push({
        source: "github repo search x402",
        url: repo.html_url,
        title: repo.full_name || "",
        body: repo.description || "",
        dateMs,
        forcedAngle: fresh ? ANGLE_INTEGRATE : null,
        onlyIfFresh: true, // repos only qualify via the 7-day rule or keywords
      });
    }
  } catch (err) {
    noteError("github search", err);
  }
  try {
    const prs = await fetchJson(
      "https://api.github.com/repos/coinbase/x402/pulls?state=open&per_page=10",
      { Accept: "application/vnd.github+json" }
    );
    for (const pr of prs || []) {
      const dateMs = Date.parse(pr.updated_at || pr.created_at || "") || null;
      const fresh = dateMs && NOW - dateMs <= MS_7D;
      out.push({
        source: "github coinbase/x402 open PR",
        url: pr.html_url,
        title: pr.title || "",
        body: (pr.body || "").slice(0, 2000),
        dateMs,
        forcedAngle: fresh ? ANGLE_INTEGRATE : null,
        onlyIfFresh: true,
      });
    }
  } catch (err) {
    noteError("github x402 PRs", err);
  }
  return out;
}

async function collectNpm() {
  const out = [];
  try {
    const data = await fetchJson(
      "https://registry.npmjs.org/-/v1/search?text=x402&size=10"
    );
    for (const obj of data?.objects || []) {
      const p = obj?.package;
      if (!p) continue;
      const dateMs = p.date ? Date.parse(p.date) : null;
      const fresh = dateMs && NOW - dateMs <= MS_7D;
      out.push({
        source: "npm search x402",
        url: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
        title: p.name || "",
        body: p.description || "",
        dateMs,
        forcedAngle: fresh ? ANGLE_INTEGRATE : null,
        onlyIfFresh: true,
      });
    }
  } catch (err) {
    noteError("npm search", err);
  }
  return out;
}

async function collectBluesky() {
  const out = [];
  try {
    const data = await fetchJson(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=x402&sort=latest&limit=10"
    );
    for (const post of data?.posts || []) {
      const handle = post?.author?.handle || "unknown";
      const rkey = (post?.uri || "").split("/").pop();
      const text = post?.record?.text || "";
      out.push({
        source: "bluesky search x402",
        url: `https://bsky.app/profile/${handle}/post/${rkey}`,
        title: makeSnippet(text).slice(0, 80),
        body: text,
        dateMs: post?.record?.createdAt
          ? Date.parse(post.record.createdAt)
          : post?.indexedAt
            ? Date.parse(post.indexedAt)
            : null,
      });
    }
  } catch (err) {
    noteError("bluesky search", err);
  }
  return out;
}

// ---------------------------------------------------------------------------
// KPI lane: signals only, never drafts.
// ---------------------------------------------------------------------------

async function collectKpi(seen) {
  const kpi = {
    usdcTotal: null,
    usdcCount: null,
    newPayments: [],
    registry: "check failed",
    errors: [],
  };

  try {
    const data = await fetchJson(BLOCKSCOUT_URL);
    for (const item of data?.items || []) {
      const tokenAddr = (
        item?.token?.address ||
        item?.token?.address_hash ||
        ""
      ).toLowerCase();
      const symbol = item?.token?.symbol || "";
      if (tokenAddr !== USDC_BASE && symbol !== "USDC") continue;
      const hash = item.transaction_hash || item.tx_hash;
      if (!hash) continue;
      const decimals = Number(item?.total?.decimals ?? item?.token?.decimals ?? 6);
      const amount = Number(item?.total?.value ?? 0) / 10 ** decimals;
      if (!seen.payments[hash]) {
        seen.payments[hash] = { amount, ts: item.timestamp || null };
        kpi.newPayments.push({ hash, amount });
      }
    }
    const all = Object.values(seen.payments);
    kpi.usdcCount = all.length;
    kpi.usdcTotal = all.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  } catch (err) {
    kpi.errors.push(`blockscout: ${err.message || err}`);
  }

  try {
    const data = await fetchJson(REGISTRY_URL);
    const list = data?.servers || [];
    const entry = list
      .filter((e) => e?._meta?.["io.modelcontextprotocol.registry/official"]?.isLatest !== false)
      .map((e) => e?.server || e)
      .find((s) => (s?.name || "").includes("base-tx-explain"));
    kpi.registry = entry
      ? `listed as ${entry.name} v${entry.version || "?"}`
      : "not found in registry search";
  } catch (err) {
    kpi.registry = "check failed";
    kpi.errors.push(`registry: ${err.message || err}`);
  }

  return kpi;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(BRIEFS_DIR, { recursive: true });
  const seen = loadSeen();

  const candidates = [
    ...(await collectReddit()),
    ...(await collectHackerNews()),
    ...(await collectGitHub()),
    ...(await collectNpm()),
    ...(await collectBluesky()),
  ];

  const leads = [];
  const dedupThisRun = new Set();
  let skippedSeen = 0;
  let skippedSpeculation = 0;

  for (const c of candidates) {
    if (!c.url) continue;
    if (dedupThisRun.has(c.url)) continue;
    dedupThisRun.add(c.url);

    if (seen.urls[c.url]) {
      skippedSeen += 1;
      continue;
    }

    const text = `${c.title}\n${c.body}`;
    if (isSpeculation(text)) {
      skippedSpeculation += 1;
      continue;
    }

    let angle = c.forcedAngle || classifyText(text);
    if (!angle && c.onlyIfFresh) continue; // repos and packages need the 7-day rule or keywords
    if (!angle) continue;

    const stale = c.dateMs ? NOW - c.dateMs > MS_48H : false;

    leads.push({
      found_at: new Date().toISOString(),
      source: c.source,
      url: c.url,
      title: makeSnippet(c.title).slice(0, 200),
      snippet: makeSnippet(c.body || c.title),
      angle,
      stale,
    });
  }

  // KPI lane runs regardless of lead results.
  const kpi = await collectKpi(seen);

  // Persist: queue.jsonl (append), seen.json (rewrite).
  for (const lead of leads) {
    appendFileSync(QUEUE_PATH, JSON.stringify(lead) + "\n");
    seen.urls[lead.url] = lead.found_at;
  }
  writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2) + "\n");

  // Brief.
  const today = new Date().toISOString().slice(0, 10);
  const briefPath = join(BRIEFS_DIR, `${today}.md`);
  const staleCount = leads.filter((l) => l.stale).length;

  const runStamp = new Date().toISOString().slice(11, 16) + " UTC";
  const lines = [];
  lines.push(`# Growth scan brief, ${today} (${runStamp})`);
  lines.push("");
  lines.push(
    `${leads.length} new lead(s), ${staleCount} flagged stale. This file is for human review. Read the actual thread, edit the stub, and post manually from the right account. Never paste a stub unedited.`
  );
  lines.push("");

  const angleOrder = [ANGLE_DECODE, ANGLE_MONETIZE, ANGLE_INTEGRATE];
  for (const angle of angleOrder) {
    const group = leads.filter((l) => l.angle === angle);
    if (group.length === 0) continue;
    const suffix = angle === ANGLE_DECODE ? " (highest intent)" : "";
    lines.push(`## ${angle}${suffix}`);
    lines.push("");
    for (const lead of group) {
      lines.push(`### ${lead.title || lead.url}`);
      lines.push("");
      lines.push(`- Link: ${lead.url}`);
      lines.push(`- Source: ${lead.source}`);
      lines.push(`- Stale (older than 48h): ${lead.stale ? "yes" : "no"}`);
      lines.push("");
      if (lead.snippet) {
        lines.push(`> ${lead.snippet}`);
        lines.push("");
      }
      lines.push("Draft stub (edit before posting):");
      lines.push("");
      lines.push(`> ${DRAFT_STUBS[angle]}`);
      lines.push("");
    }
  }

  if (leads.length === 0) {
    lines.push("No new leads this run.");
    lines.push("");
  }

  lines.push("## KPI");
  lines.push("");
  if (kpi.usdcTotal !== null) {
    lines.push(
      `- USDC received (tracked across runs): $${kpi.usdcTotal.toFixed(2)} over ${kpi.usdcCount} transfer(s)`
    );
    if (kpi.newPayments.length > 0) {
      const newSum = kpi.newPayments.reduce((s, p) => s + p.amount, 0);
      lines.push(
        `- New since last run: ${kpi.newPayments.length} transfer(s), $${newSum.toFixed(2)}`
      );
      for (const p of kpi.newPayments) {
        lines.push(`  - $${p.amount.toFixed(2)} ${p.hash}`);
      }
    } else {
      lines.push("- New since last run: none");
    }
  } else {
    lines.push("- USDC check failed this run");
  }
  lines.push(`- MCP registry: ${kpi.registry}`);
  if (sourceErrors.length > 0 || kpi.errors.length > 0) {
    lines.push(
      `- Sources skipped this run: ${[...sourceErrors, ...kpi.errors].join("; ")}`
    );
  }
  lines.push("");

  // Same-day reruns append rather than clobbering the earlier brief.
  if (existsSync(briefPath)) {
    appendFileSync(briefPath, "\n---\n\n" + lines.join("\n"));
  } else {
    writeFileSync(briefPath, lines.join("\n"));
  }

  // Console summary.
  const kpiLine =
    kpi.usdcTotal !== null
      ? `USDC total $${kpi.usdcTotal.toFixed(2)} (${kpi.usdcCount} transfers), ${kpi.newPayments.length} new since last run; registry: ${kpi.registry}`
      : `USDC check failed; registry: ${kpi.registry}`;
  console.log(
    `growth-scan: ${leads.length} new lead(s), ${staleCount} stale, ${skippedSeen} already seen, ${skippedSpeculation} skipped as speculation.`
  );
  console.log(`growth-scan: KPI: ${kpiLine}`);
  console.log(`growth-scan: brief written to ${briefPath}`);
  if (sourceErrors.length > 0) {
    console.log(`growth-scan: skipped sources: ${sourceErrors.join("; ")}`);
  }
}

main().catch((err) => {
  // A total failure still exits 0: this is an advisory scanner, not a build step.
  console.error(`growth-scan: run failed: ${err?.message || err}`);
  process.exitCode = 0;
});
