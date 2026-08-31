#!/bin/sh
# Does this offer page comply with the gate, or does it just look like it does?
#
# Enforces Security's offer-gate mechanically, because the failure mode for a
# page written fast at 3am is not carelessness -- it is a banned word that reads
# naturally. "Security review" is the obvious name for the thing we are selling
# and is exactly the name we may not use.
#
#   offer-check.sh <page.html>              an OFFER page (must state price etc.)
#   offer-check.sh --mechanics <page.html>  a MECHANICS page (deliberately priceless)
#
# TWO PAGE TYPES, and the distinction is not cosmetic. An offer page must carry
# a price, a deliverable and a risk reversal or a buyer cannot say yes in one
# read. A mechanics page -- how payment works, what a receipt is -- must carry
# NONE of those: its whole job is to be linked from many different offers, so a
# price on it would contradict whichever offer sent the reader.
#
# This mode exists because the first run of this gate REJECTED a compliant
# mechanics page for lacking a price it was specified not to have. A gate
# applied outside its scope produces false failures exactly as reliably as one
# scoped too narrowly produces false passes -- and the fix people reach for
# when a gate cries wolf is to stop running it.
set -eu
MODE=offer
if [ "${1:-}" = "--mechanics" ]; then MODE=mechanics; shift; fi
f="$1"; fails=0
bad() { printf '\n  FAIL  %s\n        %s\n' "$1" "$2"; fails=$((fails+1)); }
ok()  { printf '  ok    %s\n' "$1"; }

printf 'offer-check: %s\n\n' "$f"

# 1..3 run against RENDERED TEXT ONLY, via python.
#
# The first version of this checker failed the compliant template twice: it
# matched the banned words inside the HTML comment that LISTS them as
# instructions, and it matched the honest disclaimer "Not a verdict. ... does
# not certify ..." -- the exact sentence the gate exists to require. A check
# that blocks the correct page is worse than no check, because the fix people
# reach for is deleting the disclaimer.
#
# So: strip comments and scripts, then ignore any hit sitting in a negated
# context. Negation is what makes "not a verdict" honest and "a verdict" a
# violation, and only the surrounding words distinguish them.
python3 - "$f" <<'PYEOF' || fails=$((fails+1))
import html, re, sys
raw = open(sys.argv[1], encoding="utf-8").read()
body = re.sub(r"<!--.*?-->", " ", raw, flags=re.S)
body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", body, flags=re.S|re.I)
# PER-BLOCK, not per-page. Negation only excuses a banned term inside the SAME
# text block. Checking the whole page as one string let the heading "What this
# is not" sit within the negation window of a list item below it and excuse a
# genuine "We issue a verdict" -- a false NEGATIVE, which on a gate is worse
# than the false positive it was introduced to fix. Widening a window trades
# one failure direction for the other; respecting structure fixes both.
BLOCK = r"</?(?:p|li|h[1-6]|div|section|dd|dt|td|blockquote)\b[^>]*>"
blocks = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", b)) for b in re.split(BLOCK, body)]
text = " ".join(blocks)
# A curly apostrophe defeated this once: "don’t offer uptime" failed to match
# a negation list written with straight quotes, so an HONEST disclaimer was
# flagged as a violation. Normalise before matching.
# Entities first: the page writes don&rsquo;t, and an un-unescaped &rsquo;
# is not a curly quote, so normalising quotes alone did nothing at all.
blocks = [html.unescape(b).replace("’", "'").replace("‘", "'") for b in blocks]
text = html.unescape(text).replace("’", "'").replace("‘", "'")

# Window widened 3 -> 8. "Not a review that issues a verdict" puts SIX words
# between negation and term, and that sentence is required copy, not a slip.
NEG = r"(?:not|never|no|isn't|does not|doesn't|don't|cannot|can't|without)\s+(?:\w+\s+){0,8}"
CHECKS = [
    ("verdict or banned naming",
     r"\b(audit|audits|audited|security review|safety review|penetration test|pentest|certif(?:y|ied|ication)|guarantee[ds]?|verdict|clean bill|assur(?:e|ed|ance))\b",
     "We sell observations and diagnostics. The name is part of the claim."),
    ("implies a track record we do not have",
     r"\b(trusted by|our clients|customers trust|our case stud(?:y|ies)|testimonials?|we've helped|hundreds of|thousands of|industry.leading|proven track record)\b",
     "Ceiling: one promoted customer, one solicited proof."),
    ("SLA or support-response promise",
     r"\b(uptime|SLA|99\.[0-9]+%|24/7|same.day support|guaranteed availability)\b",
     "No uptime or support-time promises."),
]
bad = 0
for label, pat, why in CHECKS:
    hits = []
    for blk in blocks:
        for m in re.finditer(pat, blk, re.I):
            pre = blk[max(0, m.start()-70):m.start()]
            if re.search(NEG + r"$", pre, re.I):
                continue                  # negated in ITS OWN block -> honest
            hits.append(m.group(0))
    if hits:
        print(f"\n  FAIL  {label}")
        print("        " + ", ".join(sorted(set(hits))))
        print("        " + why)
        bad += 1
    else:
        print(f"  ok    {label.replace('or banned naming','/naming clean').replace('implies a','no implied').replace('SLA or support-response promise','no SLA or support promise')}")
sys.exit(1 if bad else 0)
PYEOF

# 4. USDC must LEAD. What is banned is a fiat RAIL on the page -- a Stripe
#    link or a "pay with card" CTA -- not the honest sentence that fiat can be
#    arranged. The original rule said "never above $600"; ruling B (named
#    counterparties, ~$2k) superseded it, and this comment was itself stale
#    within hours of being written.
if ! grep -qi 'USDC' "$f"; then
  bad "no USDC path on the page" "USDC should lead: it settles in seconds and needs no account with us."
else ok "USDC path present"; fi
if python3 -c "
import re,sys
raw=open('$f',encoding='utf-8').read()
b=re.sub(r'<!--.*?-->',' ',raw,flags=re.S)
b=re.sub(r'<(script|style)\\b[^>]*>.*?</\\1>',' ',b,flags=re.S|re.I)
t=re.sub(r'<[^>]+>',' ',b)
sys.exit(0 if re.search(r'stripe|pay with card|credit card',t,re.I) else 1)
"; then
  bad "fiat rail referenced" "A fiat RAIL (a Stripe link, a card CTA) must not be offered on the page.
        Saying fiat can be arranged on request is fine and is now policy --
        the founder ruled identity exposure acceptable for named
        counterparties at ~\$2k, which superseded the blanket \$600 line this
        check was written under. Our own gates go stale too."
else ok "no fiat rail referenced"; fi

# 5. every slot filled
HITS=$(grep -o '{{[A-Z_0-9]*}}' "$f" || true)
if [ -n "$HITS" ]; then
  bad "unfilled template slots" "$(printf '%s' "$HITS" | sort -u | tr '\n' ' ' | sed 's/^/        /')"
else ok "no unfilled slots"; fi

# 6. offer pages only: the facts a buyer needs to say yes in one read.
if [ "$MODE" = "offer" ]; then
  for need in "You get" "Deliver" "USDC"; do
    grep -qiE "$need" "$f" || bad "missing required element: $need" "A buyer cannot say yes in one read without it."
  done
  # RISK REVERSAL: enforce the PROPERTY, not the implementation that happened to
  # embody it when this was written.
  #
  # A stranger with no reason to trust us needs a reason the downside is bounded.
  # This check originally demanded PAY-ON-ARTIFACT ("owe nothing until we
  # deliver") because that is the engagement model it was written against. On
  # 2026-08-31 that hardcoding failed a CORRECT offer: a $1,000/mo PREPAID
  # monitoring subscription, where payment necessarily comes first. Satisfying
  # the old pattern would have required copy that CONTRADICTED the terms the
  # buyer had already accepted -- i.e. passing the gate by making the page false,
  # which is the exact failure this file exists to prevent.
  #
  # Fourth instance that week of a gate scoped to the shape of past work. It
  # matters more than the others because PAYDAY.2 abandons the old market, buyer,
  # technology AND BUSINESS MODEL, so this would have misfired on every correct
  # new-model offer we write from here.
  #
  # THE COMMERCIAL DEFINITION (Revenue, 2026-08-31, so the next reader gets the
  # reasoning and not just a regex): risk reversal under a PREPAID model at this
  # company means ASSESS-BEFORE-RENEWAL plus the no-argue clause -- the buyer
  # judges the first period against their own data before there is any renewal
  # ask, and we do not argue them into a second one. It is deliberately NOT a
  # refund right; no money moves backward. A refund right is a founder sentence.
  #
  # Either shape satisfies the property. Neither present is still a failure.
  RR_PREPAID="assess(ed)? (it )?against your own|before there.s any renewal|before renewal|judge what that was worth|argue you into a second"
  RR_ARTIFACT="before you pay|pay after|paid on delivery|never before|after you have|owe nothing"
  if grep -qiE "$RR_ARTIFACT" "$f"; then
    ok "risk reversal stated (pay-on-artifact)"
  elif grep -qiE "$RR_PREPAID" "$f"; then
    ok "risk reversal stated (assess-before-renewal)"
  else
    bad "no risk reversal stated in either accepted shape" \
      "A stranger needs the downside bounded before they start. Accepted:
        pay-on-artifact (owe nothing until we deliver), OR assess-before-renewal
        (they judge the first period against their own data before any renewal
        ask, and we do not argue them into a second). One or the other, always."
  fi
else
  # A mechanics page must still make the order of events unmistakable, since
  # pay-on-artifact is the whole reason a stranger is willing to start.
  grep -qiE 'work first|paid on delivery|then you pay|you get the work' "$f" \
    && ok "mechanics page states work-before-payment order" \
    || bad "mechanics page does not state the work-before-payment order" \
         "Pay-on-artifact is the reason a stranger starts. It must be unmissable."
  grep -qiE '\$[0-9]|USDC [0-9]|price' "$f" \
    && bad "mechanics page names a price" \
         "Prices live in the offer, never here -- this page is linked from many
        offers and would contradict whichever one sent the reader." \
    || ok "no price on the mechanics page (correct)"
fi

# 7. site shell inherited verbatim
grep -q 'footer-status' "$f" || bad "footer status pill missing" "Site consistency contract: shell copied verbatim."
grep -q 'id="site-menu"' "$f" || bad "nav missing" "Site consistency contract: shell copied verbatim."
grep -q 'footer-status' "$f" && grep -q 'id="site-menu"' "$f" && ok "site shell intact"

printf '\n'
[ "$fails" -gt 0 ] && { printf 'offer-check: %s FAILED. Not publishable.\n\n' "$fails"; exit 1; }
printf 'offer-check: OK\n'
