#!/bin/sh
#
# Can we still take money, and would we know if we couldn't?
#
# WHY THIS EXISTS. The payout wallet was rotated on 2026-08-23. If the server had
# kept quoting the retired address in its x402 challenge, every payer's USDC
# would have landed in a wallet nobody watches, and we would have found out from
# a customer — or not at all. Nothing checked for that. Separately, the card
# rail's webhook secret sat unverified for days because "configured" and
# "working" were never distinguished, and the reconciler twice announced a
# phantom drain because it compared figures across two payment rails.
#
# Every one of those is CONFIG DRIFTING OUT FROM UNDER A LIVE REVENUE RAIL, and
# every one is cheap to detect and expensive to discover late.
#
# WHAT IT DELIBERATELY DOES NOT DO: move money. Proving settlement end-to-end
# needs a signed USDC transfer, which needs a funded key. An automated agent
# holding standing signing authority over the founder's funds is a worse risk
# than the one this check removes, so the last mile stays manual. This verifies
# everything UP TO the payment — which is where the rotation-class break lives.
#
# Read-only, and every request carries the internal marker so a scheduled run
# can never be mistaken for a customer. That mattered: an unmarked probe of
# /paid put a phantom "stuck buyer" on the dashboard within an hour of that
# gauge shipping.
#
# WHAT THIS DOES **NOT** COVER. Stated because Surface has stopped hand-checking
# the /paid contract on the strength of this script, which makes its blind spots
# theirs. A check trusted beyond its scope is the "reads as coverage while
# providing none" failure wearing a new hat, and it is the one this codebase
# keeps rebuilding:
#
#   - The SUCCESS path. `mcp_url` on a 200 is never exercised, because that
#     needs a real unredeemed pass. If pass delivery breaks, this stays green.
#   - Settlement. No money moves, so "a payer's funds actually arrive" is
#     untested by construction — see the note above about funded keys.
#   - The page itself. This checks what the SERVER returns, not that
#     site/pricing/index.html still reads it correctly. A change on the page
#     side is invisible here.
#   - Whether anyone reads security@0200project.com, which is the last stage of
#     the only safety net on a stranded buyer.
#
# USAGE
#   scripts/qualitycheck.sh          # human-readable, exit 1 on any failure
#   scripts/qualitycheck.sh --quiet  # only failures (for cron)

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
URL="${BTX_URL:-https://api.0200project.com}"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1

MARKER=""
if [ -n "${INTERNAL_MARKER:-}" ]; then MARKER="$INTERNAL_MARKER"
elif [ -f "$ROOT/.internal-marker" ]; then MARKER="$(tr -d '\n' < "$ROOT/.internal-marker")"
else
  echo "FAIL setup: no internal marker. Refusing to run unlabelled — a scheduled" >&2
  echo "     probe counted as a customer is worse than no check at all." >&2
  exit 2
fi

TOKEN=""
if [ -n "${STATS_TOKEN:-}" ]; then TOKEN="$STATS_TOKEN"
elif [ -f "$ROOT/.stats-token" ]; then TOKEN="$(tr -d '\n' < "$ROOT/.stats-token")"; fi

FAILED=0
pass() { [ "$QUIET" -eq 1 ] || printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; printf '        %s\n' "$2" >&2; FAILED=$((FAILED + 1)); }

get()  { curl -sS -m 20 -H "x-btx-internal: $MARKER" "$@"; }

[ "$QUIET" -eq 1 ] || echo "quality check against $URL"

# ---- 1. Is it up, and are payments enabled at all? --------------------------
HEALTH="$(get "$URL/healthz" || true)"
if printf '%s' "$HEALTH" | grep -q '"ok":true'; then pass "server responding"
else fail "server not responding" "GET /healthz did not return ok:true"; fi

if printf '%s' "$HEALTH" | grep -q '"payments_ready":true'; then pass "payments_ready"
else fail "payments NOT ready" "the facilitator was unreachable; we are serving the free tier only and charging nobody"; fi

# ---- 2. THE ROTATION CHECK. Does the live challenge quote the live wallet? --
# The one this script was written for. A mismatch means every payer's money
# goes somewhere we do not watch, silently, until someone complains.
WANT="$(printf '%s' "${X402_PAY_TO:-}" | tr 'A-Z' 'a-z')"
if [ -z "$WANT" ] && [ -f "$ROOT/fly.toml" ]; then
  WANT="$(sed -n "s/.*X402_PAY_TO = '\(0x[a-fA-F0-9]*\)'.*/\1/p" "$ROOT/fly.toml" | head -1 | tr 'A-Z' 'a-z')"
fi

CHAL="$(curl -sS -m 20 -D - -o /dev/null -X POST "$URL/pass" \
  -H 'content-type: application/json' -H "x-btx-internal: $MARKER" -d '{}' 2>/dev/null || true)"
B64="$(printf '%s' "$CHAL" | tr -d '\r' | sed -n 's/^[Pp]ayment-[Rr]equired: //p' | head -1)"

if [ -z "$B64" ]; then
  fail "no x402 challenge on /pass" "the paid endpoint did not issue a payment-required header; the rail is not quoting a price"
else
  GOT="$(printf '%s' "$B64" | base64 -d 2>/dev/null | sed -n 's/.*"payTo":"\(0x[a-fA-F0-9]*\)".*/\1/p' | tr 'A-Z' 'a-z')"
  if [ -z "$GOT" ]; then
    fail "challenge has no payTo" "decoded the challenge but found no payTo — a payer has nowhere to send funds"
  elif [ -z "$WANT" ]; then
    fail "cannot read expected payout wallet" "no X402_PAY_TO in env or fly.toml, so the challenge cannot be checked against anything"
  elif [ "$GOT" = "$WANT" ]; then
    pass "challenge payTo matches the live payout wallet"
  else
    fail "PAYOUT WALLET MISMATCH" "challenge quotes $GOT but the configured payout wallet is $WANT. Every x402 payment is landing in the wrong address. STOP AND FIX."
  fi
fi

# ---- 3. The buyer-facing contract the pricing page depends on --------------
# Surface's success page gates its whole not-ready branch on the 404 and renders
# `error` to the buyer. A status or shape change silently reroutes a legitimate
# still-processing buyer into a generic error.
PAID_CODE="$(curl -sS -m 20 -o /tmp/.qc_paid -w '%{http_code}' -H "x-btx-internal: $MARKER" \
  "$URL/paid?session_id=cs_qualitycheck_probe_0000" 2>/dev/null || echo 000)"
if [ "$PAID_CODE" = "404" ] && grep -q '"code":"not_ready"' /tmp/.qc_paid 2>/dev/null; then
  pass "/paid not-ready contract intact (404 + not_ready)"
else
  fail "/paid contract changed" "expected 404 with code:not_ready, got $PAID_CODE. The pricing page keys on this; a buyer mid-payment would see a generic error instead of 'still processing'."
fi

# THE `error` STRING IS USER-FACING COPY, NOT AN INTERNAL MESSAGE.
# site/pricing/index.html renders `r.body.error` directly to the buyer for the
# first 45 seconds of waiting. Surface owns that page and has stopped
# hand-verifying this contract because this script exists — so a reword here
# would reach a paying customer with nobody watching. Pinned deliberately: this
# failing is a COORDINATION signal, not necessarily a bug.
EXPECT_ERR='No pass is available for that session yet. If you just paid, wait a few seconds and reload.'
if grep -qF "$EXPECT_ERR" /tmp/.qc_paid 2>/dev/null; then
  pass "/paid buyer-facing copy unchanged"
else
  fail "/paid 'error' copy changed" "the pricing page renders this string straight to a paying buyer. If the change was intentional, tell Surface and update EXPECT_ERR here. If it was not, a buyer is being shown something nobody wrote for them."
fi

if grep -qi 'access-control-allow-origin' /tmp/.qc_paid.h 2>/dev/null; then :; fi
CORS="$(curl -sS -m 20 -D - -o /dev/null -H "x-btx-internal: $MARKER" "$URL/paid?session_id=cs_qualitycheck_probe_0000" 2>/dev/null | tr -d '\r' | grep -ci '^access-control-allow-origin' || true)"
if [ "${CORS:-0}" -ge 1 ]; then pass "/paid CORS present (the page fetches cross-origin)"
else fail "/paid CORS missing" "the success page is on another origin; without CORS it cannot read the pass and every card buyer sees a failure"; fi

# ---- 4. Token-gated state: has anything started going wrong? ---------------
if [ -n "$TOKEN" ]; then
  S="$(get -H "x-stats-token: $TOKEN" "$URL/stats" || true)"

  case "$S" in
    *'"status":"REJECTING_SIGNED_DELIVERIES"'*)
      fail "webhook REJECTING signed deliveries" "a well-formed Stripe signature did not match our secret. Card buyers may be charged and receive nothing. Read the Stripe delivery log NOW." ;;
    *'"status":"healthy"'*)      pass "card rail healthy (a live purchase has minted)" ;;
    *'"status":"secret_verified"'*) pass "card rail secret verified (no live purchase has minted yet)" ;;
    *'"status":"never_exercised"'*) fail "card rail never exercised" "no signed delivery has ever verified; the card rail is UNPROVEN, not working" ;;
  esac

  case "$S" in
    *'"status":"overbooked"'*)
      fail "reconciler: overbooked" "the ledger books more on-chain revenue than the chain holds. Either revenue was booked that never arrived, or funds left the payout wallet undeclared." ;;
    *'"status":"unbooked_revenue"'*)
      fail "reconciler: unbooked revenue" "money arrived on chain that the ledger never booked. Real money, unrecorded." ;;
    *'"status":"reconciled"'*) pass "reconciler balanced" ;;
  esac

  STUCK="$(printf '%s' "$S" | sed -n 's/.*"buyers_stuck":\([0-9]*\).*/\1/p' | head -1)"
  if [ "${STUCK:-0}" -gt 0 ]; then
    fail "$STUCK buyer(s) stuck" "someone paid and has no pass, past the point where 'still processing' explains it. Check Stripe and the payout wallet."
  else
    pass "no stuck buyers"
  fi
else
  [ "$QUIET" -eq 1 ] || echo "  skip  token-gated checks (no .stats-token)"
fi

rm -f /tmp/.qc_paid

if [ "$FAILED" -gt 0 ]; then
  echo "" >&2
  echo "$FAILED check(s) FAILED — a revenue path may be broken." >&2
  exit 1
fi
[ "$QUIET" -eq 1 ] || echo "all checks passed"
