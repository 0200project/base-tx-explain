#!/usr/bin/env bash
# name-collision.sh — collision-test a candidate token/network name before anyone gets
# attached to it. Growth, 2026-09-02.
#
# WHICH INSTRUMENT THIS IS, said out loud because it matters:
#   This runs SYMBOL SEARCH, not address lookup. Symbol search is a RANKED, FILTERED view
#   that drops low-liquidity and low-organic-score tokens. Address lookup is the index
#   itself. They answer different questions, and on 2026-09-02 confusing the two produced a
#   wrong "no such token exists" verdict from this seat.
#   Symbol search is the CORRECT instrument here — it is what a real person types.
#   What it CANNOT tell you: whether a dormant token holds the name in an index somewhere.
#   That question needs a mint address, which you only have after you find it.
#
# Usage:  ./scripts/name-collision.sh NAME [NAME...]
# Keyless. No writes. Read-only against three public search surfaces.

set -uo pipefail

PY="$(cd "$(dirname "$0")" && pwd)/lib/name_collision.py"

for NAME in "$@"; do
  E=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$NAME")
  printf '\n=== %s ===\n' "$NAME"
  curl -s --max-time 20 "https://lite-api.jup.ag/tokens/v2/search?query=$E"        | python3 "$PY" jupiter     "$NAME"
  curl -s --max-time 20 "https://api.dexscreener.com/latest/dex/search?q=$E"       | python3 "$PY" dexscreener "$NAME"
  curl -s --max-time 20 "https://api.coingecko.com/api/v3/search?query=$E"         | python3 "$PY" coingecko   "$NAME"
done

cat <<'NOTE'

EXACT = symbol or name matches the candidate exactly; fuzzy hits are noise.
CoinGecko EXACT carrying a market-cap rank is the strongest disqualifier: a real listing a
real person finds. Jupiter/DexScreener EXACT with ~0 holders and no liquidity is a DEAD
launch, not a collision — see the pump.fun 0200 (1 holder, no pool) on 2026-09-02.
NOTE
