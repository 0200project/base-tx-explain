/**
 * What KIND of thing called us — a person, a script, or a crawler.
 *
 * WHY THIS EXISTS. Every arrival question tonight has been answered by
 * inference from timing: two addresses four seconds apart looked like probe
 * nodes, a return eight hours later looked like a person, and both readings
 * could have been wrong. The `user-agent` header answers directly what we have
 * been triangulating, and we were not looking at it — a scanner announces
 * itself in that header roughly as often as it does not.
 *
 * WHAT IS STORED, AND WHY NOT THE HEADER ITSELF. Only a fixed classification —
 * never the raw string. The raw value is caller-controlled and would otherwise
 * reach the ledger and the founder's dashboard, which is the token-symbol
 * injection surface on a third rail; and it is a fingerprint we have no use
 * for. The question is "person, script, or crawler", so store the answer to
 * that question and nothing else. Strictly less retained than logging the
 * header, and it answers the thing we actually ask.
 *
 * IT IS A HINT, NOT PROOF. A user-agent is self-reported, exactly like the
 * `?ref=` channel. Anything wanting to look like a browser can. It is useful
 * because most automated traffic does not bother to lie, not because it cannot.
 * Every surface that prints these counts must say so.
 *
 * UNKNOWN AND ABSENT GET THEIR OWN BUCKETS, for the same reason `direct` and
 * `pre_attribution` do: a category with nowhere to go lands somewhere, and it
 * lands somewhere flattering. An unclassifiable caller must not quietly become
 * evidence of a person.
 */

export type ClientKind =
  /** Announces itself as a crawler, spider, or link-preview fetcher. */
  | 'bot_declared'
  /** A real browser engine — a person clicked something. */
  | 'browser'
  /** curl, wget, httpie: a person exploring by hand. */
  | 'cli'
  /** An HTTP client library — a script, an agent, an integration. Our buyer. */
  | 'http_library'
  /** No user-agent header at all. Common for minimal/bespoke clients. */
  | 'absent'
  /** Present but matching nothing we recognise. */
  | 'unknown';

/** Cap before ANY other work touches the value — it is caller-controlled. */
const MAX_RAW = 256;

/**
 * Ordered most-specific first. `bot_declared` is checked before `browser`
 * because link-preview fetchers routinely carry a full browser UA plus a bot
 * token, and the bot token is the honest part.
 */
const RULES: Array<[ClientKind, RegExp]> = [
  [
    'bot_declared',
    /(bot\b|crawler|spider|scrape|preview|facebookexternalhit|slackbot|discordbot|twitterbot|whatsapp|telegrambot|embedly|quora link|redditbot|linkedinbot|applebot|bingpreview|headlesschrome|puppeteer|playwright|phantomjs|monitor|uptime|pingdom|statuscake|zabbix|nagios)/,
  ],
  ['cli', /(^curl\/|^wget\/|httpie|^lwp-request|^fetch\/)/],
  [
    'http_library',
    /(python-requests|aiohttp|httpx|python-urllib|node-fetch|undici|axios|got\/|okhttp|go-http-client|reqwest|hyper\/|java\/|apache-httpclient|guzzle|libwww-perl|restsharp|^node\b|^bun\b|^deno\b|mcp|langchain|openai|anthropic)/,
  ],
  ['browser', /(mozilla\/|chrome\/|safari\/|firefox\/|edg\/|opera\/|webkit)/],
];

/**
 * Classify a caller. Never throws, never returns the input, always returns
 * exactly one bucket so the totals reconcile against the call count.
 */
export function clientKind(userAgent: unknown): ClientKind {
  if (typeof userAgent !== 'string') return 'absent';
  const ua = userAgent.slice(0, MAX_RAW).trim().toLowerCase();
  if (!ua) return 'absent';
  for (const [kind, re] of RULES) {
    if (re.test(ua)) return kind;
  }
  return 'unknown';
}

/** Every bucket, so a report shows zeroes rather than gaps. */
export const CLIENT_KINDS: ClientKind[] = [
  'bot_declared',
  'browser',
  'cli',
  'http_library',
  'absent',
  'unknown',
];

/**
 * One sentence for any surface that prints these counts.
 *
 * Exported rather than rewritten per-surface because the same caveat belongs on
 * the dashboard, on `/stats` and in the daily report, and three copies of one
 * caveat drift — the copy that drifts being the one somebody external reads.
 */
export const CLIENT_KIND_CAVEAT =
  'Client kind is inferred from the self-reported user-agent and is a hint, not proof: anything can claim to be a browser. ' +
  'It is useful because most automated traffic does not bother to lie. The raw header is never stored — only this classification. ' +
  'Our own marked internal traffic is excluded entirely.';
