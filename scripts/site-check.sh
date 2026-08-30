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
API="${BTX_URL:-https://api.0200project.com}"

# Every surface that states these facts to a buyer or an agent.
#
# README.md was added on 2026-08-26 after it drifted precisely BECAUSE this
# check only looked at site/. While the site was corrected end to end, the
# README still advertised ten free calls and named a registry entry that had
# been deleted hours earlier -- and it is the worse place to be wrong: GitHub
# renders it as the repo landing page, and the Apify marketplace renders it as
# the product page for a listing that bills real money. A gate scoped to one
# surface silently certifies the others.
SITE="$ROOT/site"
SURFACES="$ROOT/site $ROOT/README.md"

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
# Whitespace-normalised copy for value extraction. The sed patterns below match
# `"key":value` with no spaces, so a pretty-printed or reserialised /healthz --
# exactly what a rewrite of that endpoint tends to produce -- made every
# extraction return empty. Proven: indent=2 output failed this gate with a
# misleading "no readable free_tier block". None of the values we read (a
# semver, two integers) can contain whitespace, so stripping it is safe here.
HEALTH_FLAT="$(printf '%s' "$HEALTH" | tr -d '[:space:]')"
if [ -z "$HEALTH" ]; then
  fail "could not reach $API/healthz" \
    "The check cannot verify anything without the server's own numbers. If the
        server is genuinely down that is the finding; if this is a network
        blip, rerun. Do NOT hardcode the expected value to get past this."
else
  CALLS="$(printf '%s' "$HEALTH_FLAT" | sed -n 's/.*"free_tier":{[^}]*"calls":\([0-9]*\).*/\1/p')"
  HOURS="$(printf '%s' "$HEALTH_FLAT" | sed -n 's/.*"free_tier":{[^}]*"window_hours":\([0-9]*\).*/\1/p')"

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
               $SURFACES 2>/dev/null \
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
    # Any phrasing that conveys sharing counts: "per IP address", "Every IP
    # address gets", "counted per client IP", "/64". An earlier draft demanded
    # one literal phrase and flagged two pages that do say it, phrased
    # differently. A check that cries wolf is one people learn to skip.
    #
    # 2026-08-29: "network" used to be in the accepted list, because the tier
    # was believed to be per-network when this branch was written. When that
    # fact was retired the list was never updated, so a line reading "50 free
    # calls per network" PASSED -- certified by containing the very word that
    # made it wrong. /terms/ and the README carried the retired fact under a
    # green check. A qualifier list is a second copy of the fact and goes stale
    # exactly like prose does. "network" is now DISQUALIFYING, checked below.
    UNQUAL="$(grep -rnE "${CALLS} (free calls|calls)" $SURFACES 2>/dev/null \
              | grep -v '/changelog/' \
              | grep -vE 'per IP|IP address|client IP|/64|shared' || true)"

            # Separate, louder failure: prose that actively states the retired rule.
            # Not merely unqualified -- affirmatively wrong, wherever it appears.
            PERNET="$(grep -rniE '(each|per|every) network|network gets|network.{0,25}free (call|tier)' \
                      $SURFACES 2>/dev/null || true)"
            if [ -n "$PERNET" ]; then
              fail "a surface states the RETIRED per-network free tier" \
                "$(printf '%s' "$PERNET" | sed "s|$ROOT/||" | sed 's/^/        /')
                The allowance is per IP address (IPv6 /64), never per network.
                Rewrite the claim; do not add a qualifier beside it."
            fi
    if [ -n "$UNQUAL" ]; then
      fail "a free-tier claim does not say the allowance is shared per IP address" \
        "$(printf '%s' "$UNQUAL" | sed "s|$ROOT/||" | sed 's/^/        /')
        Reads as a personal allowance. It is shared by everyone behind one
        address, which is exactly what walled a real first-time visitor."
    else
      pass "every free-tier claim is qualified per IP address, on its own line"
    fi
  fi
fi

# ------------------------------------------------------------------- version
#
# The footer stamps a version on every page. It has drifted twice: v0.1.2 while
# the server served 0.1.3, then thirteen pages on 0.1.3 and one on 0.1.0 while
# the server served 0.1.4. Both times it was fixed by hand and both times the
# hand-fix is what failed next. /healthz already tells us the truth.

SRV_VER="$(printf '%s' "$HEALTH_FLAT" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
if [ -n "$SRV_VER" ]; then
  # Keep the FILENAME (-n, not -h): without it there is nothing to exclude the
  # changelog by, and history's own v0.1.0 / v0.1.1 entries trip a check that is
  # supposed to police LIVE claims. Broadening the pattern from the qualified
  # "base-transaction-decoder vX" form to any vX.Y.Z is what exposed this --
  # the narrow version had been silently certifying a bare "v0.1.1" pill on
  # /tools/ that a cold reader found and this check never looked at.
  BADV="$(grep -rnoE 'v[0-9]+\.[0-9]+\.[0-9]+' $SURFACES 2>/dev/null \
          | grep -v '/changelog/' \
          | grep -v ":v${SRV_VER}$" || true)"
  if [ -n "$BADV" ]; then
    fail "a page stamps a version the server is not serving (server: $SRV_VER)" \
      "$(printf '%s' "$BADV" | sed 's/^/        /')
        Pages were stamping each other instead of the server."
  else
    pass "version stamp agrees with the server (${SRV_VER})"
  fi
else
  # NOT a silent skip. This branch was `if [ -n "$SRV_VER" ]` with no else, so a
  # /healthz that stopped publishing `version` deleted the entire version check
  # -- no pass, no fail, nothing printed, gate green. Found 2026-08-29 while
  # Platform was mid-rewrite of that endpoint. Not being able to verify is a
  # finding, never a pass.
  fail "/healthz publishes no version, so no page version stamp can be checked" \
    "Every vX.Y.Z on the site is unverified while this is true.
        Restore version in /healthz, or teach this branch the new shape."
fi

# ------------------------------------------------------------------ hostname
#
# The Fly hostname was replaced by api.0200project.com because a customer
# pastes the pass URL into their client and looks at it every day. A stray
# .fly.dev on the site is not broken -- both hosts serve -- but a docs page
# telling a buyer to curl one host while their pass URL shows another is the
# same unpolished seam the rename existed to remove.

FLYREF="$(grep -rn 'base-tx-explain\.fly\.dev' $SURFACES 2>/dev/null | grep -v '/changelog/' || true)"
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

CLAIMED="$(grep -rhoE 'io\.github\.0200project/[a-z0-9-]+' $SURFACES 2>/dev/null | sort -u || true)"
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
      if grep -rn "$name" $SURFACES | grep -qv '/changelog/'; then
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

# ------------------------------------------------------- our own dead links
#
# A rename updates the CLAIM and leaves the THING behind. The 2026-08-27 rename
# repointed the site at apify.com/0200project/base-transaction-decoder while the
# Apify actor was never renamed and still lives at .../base-tx-explain. The site
# then shipped a 404 for three days on the PRICING page -- specifically the
# "have a card and no wallet at all?" button, which is the only fiat door for a
# buyer without USDC. Nothing checked it, because the internal-link checks only
# look at paths under site/ and a self-owned URL on another host is neither
# internal nor a stranger's problem.
#
# Scope is deliberately OUR properties only. A gate that pings every external
# link on the site flakes on someone else's downtime and gets ignored; these are
# the links that rot from our OWN actions, and they are the ones a buyer follows.
# 403 counts as alive: hosts cloak from scripted clients, and a cloak is not a
# missing page.

OURS="$(grep -rhoE 'https://(apify\.com|github\.com)/0200project[A-Za-z0-9/._-]*' $SURFACES 2>/dev/null \
        | sed 's/[.,)]*$//' | sort -u || true)"
if [ -z "$OURS" ]; then
  pass "no self-owned external links to verify"
else
  DEAD=""
  for u in $OURS; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 15 -A 'Mozilla/5.0' "$u" || echo 000)"
    case "$code" in
      200|301|302|403) ;;
      *) DEAD="$DEAD
        $code  $u" ;;
    esac
  done
  if [ -n "$DEAD" ]; then
    fail "the site links one of our own pages that does not resolve" "$DEAD
        A rename that updates the site without renaming the thing ships a 404
        to a buyer. Repoint the link, or rename the listing to match."
  else
    pass "every self-owned link resolves ($(printf '%s' "$OURS" | wc -l | tr -d ' ') checked)"
  fi
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
