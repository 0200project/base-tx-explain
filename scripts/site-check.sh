#!/bin/sh
#
# Does the site still tell the truth about the server?
#
# WHY THIS EXISTS. On 2026-08-26 the free tier went from 10 calls per network
# to 50, and the window from 30 days to 24 hours, to stop a shared address
# denying a first-time visitor their very first call. The server changed. The
# site did not: fourteen places across nine files went on advertising ten for
# two hours, and so did openapi.json and the MCP tool description -- the
# machine-readable contract an agent reads to decide whether we are worth
# calling. We understated our own offer by five times to every prospect and
# every agent that looked at us, in the same window we were asking why nobody
# converted.
#
# Nobody was careless. src/freeTier.ts already carried a comment warning about
# exactly this drift, written by the author of the code that drifted. The
# server-side copies were fixed by DERIVING them from FREE_CALLS, so the number
# now has one home and cannot half-move again.
#
# The site cannot import a TypeScript constant. It is the one surface where
# derivation is impossible, which makes it the one surface that needs a check.
# `/healthz` publishes `free_tier` for this purpose -- itself derived from
# FREE_CALLS and WINDOW_MS, so it cannot disagree with what the server actually
# enforces.
#
# WHAT THIS IS NOT. It is not a promise that the copy is good, or that the site
# is honest about anything else. It checks the claims that have a machine-
# readable counterpart, which today is the free tier and the API hostname. A
# claim nobody can check mechanically still needs a human to read it.
#
#   scripts/site-check.sh          # exit 1 on any mismatch
#
# Bound into scripts/site-deploy.sh so it cannot be skipped by forgetting.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
SITE="$ROOT/site"
API="${BTX_URL:-https://api.0200project.com}"

fails=0

pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '\n  FAIL  %s\n' "$1"
  printf '        %s\n\n' "$2"
  fails=$((fails + 1))
}

printf 'site-check: does the site still tell the truth about the server?\n\n'

# ---------------------------------------------------------------- free tier
#
# The server is the authority. We do not hardcode 50 here -- that would just
# move the drift to a third place and make this check the thing that lies.

HEALTH="$(curl -s --max-time 15 "$API/healthz" || true)"
if [ -z "$HEALTH" ]; then
  fail "could not reach $API/healthz" \
    "The check cannot verify anything without the server's own numbers. If the
        server is genuinely down that is the finding; if this is a network
        blip, rerun. Do NOT hardcode the expected value to get past this."
else
  CALLS="$(printf '%s' "$HEALTH" | sed -n 's/.*"free_tier":{[^}]*"calls":\([0-9]*\).*/\1/p')"
  HOURS="$(printf '%s' "$HEALTH" | sed -n 's/.*"free_tier":{[^}]*"window_hours":\([0-9]*\).*/\1/p')"

  if [ -z "$CALLS" ] || [ -z "$HOURS" ]; then
    fail "/healthz has no readable free_tier block" \
      "Expected free_tier.calls and free_tier.window_hours. If the shape moved,
        update this check -- do not delete it. Got: $(printf '%s' "$HEALTH" | head -c 200)"
  else
    # Every number the site states as a free-call allowance. Anything that
    # looks like a free-tier count but is not the server's number is drift.
    #
    # The changelog is excluded ON PURPOSE: it records what shipped on a date,
    # including the old value, and correcting history to match the present is
    # how a changelog stops being one.
    STALE="$(grep -rnoE '[0-9]+ (free calls|calls per (client|network)|calls each day|calls in any 24)' \
               "$SITE" 2>/dev/null \
             | grep -v '/changelog/' \
             | grep -vE ":[0-9]+:${CALLS} " || true)"

    if [ -n "$STALE" ]; then
      fail "site states a free-call allowance that is not the server's ${CALLS}" \
        "$(printf '%s' "$STALE" | sed "s|$ROOT/||" | sed 's/^/        /')"
    else
      pass "free-tier count agrees with the server (${CALLS})"
    fi

    # The window is stated in prose, so check the two forms actually used
    # rather than trying to parse every phrasing.
    if [ "$HOURS" = "24" ]; then
      if grep -rq -e 'a day' -e '24 hours' -e 'every day' -e 'each day' "$SITE" 2>/dev/null; then
        pass "free-tier window agrees with the server (${HOURS}h)"
      else
        fail "server meters a ${HOURS}h window but no page says so" \
          "A free tier that resets daily is a materially better offer than one
        that does not, and it is currently invisible to readers."
      fi
    else
      fail "server window is ${HOURS}h, which this check does not know how to verify in prose" \
        "The window changed. Read the site's wording and update this branch."
    fi

    # A claim of N free calls with no hint that N is shared per network reads
    # as "you personally get N". It is not; everyone behind one address shares
    # it, which is exactly what walled a real first-time visitor.
    # Checked per LINE, not per file. Scanning the whole file passes a page
    # whose only mention of "network" is unrelated JavaScript -- site/pricing
    # has `network: 'Checking network...'` in its wallet code, which satisfied
    # a file-wide grep while the actual price copy said nothing about sharing.
    # The qualifier has to sit with the claim to be read with it.
    #
    # Any phrasing that conveys sharing counts: "per network", "Every network
    # gets", "counted per network", "metered per client IP". An earlier draft
    # demanded the literal "per network" and flagged two pages that do say it,
    # phrased differently. A check that cries wolf is one people learn to skip.
    UNQUAL="$(grep -rnE "${CALLS} (free calls|calls)" "$SITE" 2>/dev/null \
              | grep -v '/changelog/' \
              | grep -vE 'network|per IP|client IP|/64|shared' || true)"
    if [ -n "$UNQUAL" ]; then
      fail "a free-tier claim does not say the allowance is shared per network" \
        "$(printf '%s' "$UNQUAL" | sed "s|$ROOT/||" | sed 's/^/        /')
        Reads as a personal allowance. It is shared by everyone behind one
        address, which is exactly what walled a real first-time visitor."
    else
      pass "every free-tier claim is qualified per network, on its own line"
    fi
  fi
fi

# ------------------------------------------------------------------ hostname
#
# The Fly hostname was replaced by api.0200project.com because a customer
# pastes the pass URL into their client and looks at it every day. A stray
# .fly.dev on the site is not broken -- both hosts serve -- but a docs page
# telling a buyer to curl one host while their pass URL shows another is the
# same unpolished seam the rename existed to remove.

FLYREF="$(grep -rn 'base-tx-explain\.fly\.dev' "$SITE" 2>/dev/null | grep -v '/changelog/' || true)"
if [ -n "$FLYREF" ]; then
  fail "site still points at the pre-rename Fly hostname" \
    "$(printf '%s' "$FLYREF" | sed "s|$ROOT/||" | sed 's/^/        /')"
else
  pass "no stale fly.dev references"
fi

# ------------------------------------------------------------ registry name
#
# The site states, as fact, which entry we are in the MCP registry. During the
# 2026-08-26 rename that claim had to be sequenced by hand: publish the new name
# first, THEN deploy the site, or the site names an entry that does not exist.
# Sequencing held by memory is sequencing that eventually does not hold, so the
# gate enforces it -- deploying ahead of the publish now fails here instead of
# shipping a lie about where to find us.
#
# Reads the registry rather than a hardcoded name, for the same reason the free
# tier reads /healthz: a check that carries its own copy of the answer becomes
# the thing that is wrong.

CLAIMED="$(grep -rhoE 'io\.github\.0200project/[a-z0-9-]+' "$SITE" 2>/dev/null | sort -u || true)"
if [ -z "$CLAIMED" ]; then
  pass "no registry-name claims on the site"
else
  for name in $CLAIMED; do
    slug="${name#io.github.0200project/}"
    if curl -s --max-time 15 \
        "https://registry.modelcontextprotocol.io/v0/servers?search=$slug&limit=100" \
        | grep -q "\"$name\""; then
      pass "registry claim resolves: $name"
    else
      # The historical changelog entry legitimately names a retired listing --
      # it records what shipped that day. Live claims must resolve; history
      # must not be rewritten to match the present.
      if grep -rn "$name" "$SITE" | grep -qv '/changelog/'; then
        fail "site claims a registry entry that is not live: $name" \
          "A reader following this finds nothing. If a rename is in flight, the
        new listing must be PUBLISHED before the site that names it is
        deployed. If this is only in the changelog it is history and fine."
      else
        pass "retired name appears only in changelog history: $name"
      fi
    fi
  done
fi

# ----------------------------------------------------------------- JSON-LD
#
# The FAQ publishes a FAQPage schema. Google requires the structured answer to
# match the visible answer; if they drift, the rich result either drops or
# shows text the page does not contain. This has been checked by hand after
# every FAQ edit, which is exactly the kind of discipline that fails quietly.

python3 - "$SITE" <<'PY' || fails=$((fails + 1))
import glob, html, json, os, re, sys

site = sys.argv[1]
bad = 0
checked = 0

for path in glob.glob(os.path.join(site, "**", "*.html"), recursive=True):
    src = open(path, encoding="utf-8").read()
    for block in re.findall(r'<script type="application/ld\+json">(.*?)</script>', src, re.S):
        try:
            data = json.loads(block)
        except Exception as e:
            print(f"\n  FAIL  {os.path.relpath(path, site)}: JSON-LD does not parse")
            print(f"        {e}\n")
            bad += 1
            continue

        # Strip script and style CONTENT, not just their tags. The first
        # version of this stripped tags only, which left the JSON-LD body
        # sitting in the "visible" text -- so every answer was found inside
        # its own JSON block and the check passed unconditionally. It read as
        # coverage while providing none, and only a deliberate-mismatch test
        # exposed it.
        #
        # Inline tags are removed rather than replaced with a space: an answer
        # containing <code>explain_transaction(tx_hash)</code>: renders with no
        # gap before the colon, and substituting a space invents one, failing a
        # page that is in fact correct. Two negative tests pinned both edges --
        # a real drift must fail, and the untouched tree must pass.
        body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", src, flags=re.S | re.I)
        visible = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", body)))
        for ent in (data.get("mainEntity") or []):
            ans = (ent.get("acceptedAnswer") or {}).get("text")
            if not ans:
                continue
            checked += 1
            if re.sub(r"\s+", " ", ans) not in visible:
                print(f"\n  FAIL  {os.path.relpath(path, site)}: JSON-LD answer is not on the page verbatim")
                print(f"        Q: {ent.get('name','?')[:70]}")
                print(f"        structured text has drifted from the visible text.\n")
                bad += 1

if bad:
    sys.exit(1)
print(f"  ok    {checked} JSON-LD answers match their visible text verbatim")
PY

# ------------------------------------------------------------------- verdict

printf '\n'
if [ "$fails" -gt 0 ]; then
  printf 'site-check: %s FAILED. The site is telling a prospect something the server will not honour.\n\n' "$fails"
  exit 1
fi
printf 'site-check: OK\n'
