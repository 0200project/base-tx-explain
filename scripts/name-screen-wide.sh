#!/usr/bin/env bash
# name-screen-wide.sh — the NON-crypto half of the identity screen: GitHub, domains, search.
# Companion to name-collision.sh (crypto surfaces). Growth, 2026-09-02.
#
# DOCTRINE, enforced by this script's output vocabulary:
#   **An unavailable source is UNKNOWN. Never convert UNREACHABLE -> CLEAN.**
#   Every check prints TAKEN / free / UNKNOWN. "UNKNOWN" is a result, not a failure to report.
#
# Deliberately NOT covered here, and NOT to be scored as clean by anyone reading the output:
#   - social handles (X/Twitter, Telegram, Discord) — need authenticated APIs
#   - TRADEMARK — a real legal search this seat is not competent to run
# Both print UNKNOWN below so their absence stays visible in the record.
#
# Usage: ./scripts/name-screen-wide.sh NAME [NAME...]

set -uo pipefail

for NAME in "$@"; do
  L=$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')
  printf '\n=== %s ===\n' "$NAME"

  # --- GitHub: user, org, and repo-name prevalence ---
  U=$(gh api "users/$L" --jq '.type + " — " + (.name // "no name") + " — " + ((.public_repos|tostring)) + " repos"' 2>/dev/null)
  if [ -n "$U" ]; then printf '  github acct   TAKEN  %s\n' "$U"; else printf '  github acct   free   (404)\n'; fi

  R=$(gh search repos "$NAME" --limit 50 --json name 2>/dev/null \
      | N="$NAME" python3 -c "
import json,sys,os
n=os.environ['N'].lower()
try: d=json.load(sys.stdin)
except Exception: print('UNKNOWN'); raise SystemExit
print(sum(1 for r in d if (r.get('name') or '').lower()==n))
")
  case "$R" in
    UNKNOWN|'') printf '  github repos  UNKNOWN (search failed — NOT clean)\n' ;;
    0)          printf '  github repos  free   (0 repos named exactly)\n' ;;
    *)          printf '  github repos  TAKEN  (%s repos named exactly)\n' "$R" ;;
  esac

  # --- Domains: resolution is a lower bound on "registered". A domain can be
  #     registered and not resolve, so `free` here means UNRESOLVED, not available. ---
  for TLD in com io xyz org; do
    if host -W 4 "$L.$TLD" >/dev/null 2>&1; then
      printf '  %-13s TAKEN  (resolves)\n' "$L.$TLD"
    else
      printf '  %-13s unresolved (NOT proof it is unregistered)\n' "$L.$TLD"
    fi
  done

  printf '  social        UNKNOWN (not checked — needs authenticated APIs)\n'
  printf '  trademark     UNKNOWN (not checked — requires competent legal search)\n'
done

cat <<'NOTE'

READ THE VOCABULARY LITERALLY.
  TAKEN      = found, verified.
  free       = the specific check returned nothing. Scope is that check only.
  unresolved = DNS did not answer. A registered, parked, or MX-only domain can look
               unresolved. This is NOT availability.
  UNKNOWN    = the source did not answer, or was never asked. NEVER score this clean.
A candidate is "clear" only when every line reads free, and no line reads UNKNOWN.
NOTE
