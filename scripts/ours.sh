#!/bin/sh
#
# Call our own server with our own labels already attached.
#
# WHY THIS EXISTS. Three times in one evening I curled production to verify
# something and forgot the internal marker, so my own verification landed in the
# ledger looking like a stranger. Twice it cost someone else real time: growth
# and finance ran down "new external clients" that turned out to be me, once
# while answering the founder's question about whether we had a customer.
#
# The marker was built precisely so the scoreboard would not depend on somebody
# remembering what they ran an hour ago — and then I depended on remembering,
# repeatedly, having written that sentence myself. The fix for "remember to
# label it" is never discipline. It is a path where the label is already on.
#
# USAGE
#   scripts/ours.sh healthz                 # public health
#   scripts/ours.sh stats                   # token-gated stats
#   scripts/ours.sh wallets                 # token-gated wallet balances
#   scripts/ours.sh explain 0x<txhash>      # REST decode, marked as ours
#   scripts/ours.sh mcp 0x<txhash>          # MCP tool call, marked as ours
#   scripts/ours.sh raw /some/path          # anything else, marked and tokened
#
# Everything it sends carries `x-btx-internal`, so nothing it does can ever be
# mistaken for a stranger. Set BTX_URL to point at a local instance.

set -eu

ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
URL="${BTX_URL:-https://base-tx-explain.fly.dev}"

read_secret() {
  # Env wins, then the on-disk file. Missing is fatal rather than silent: a run
  # without the marker is the exact mistake this script exists to prevent, and
  # falling back to "unmarked" would reproduce it while looking like it worked.
  if [ -n "${2:-}" ]; then printf '%s' "$2"; return 0; fi
  if [ -f "$ROOT/$1" ]; then tr -d '\n' < "$ROOT/$1"; return 0; fi
  echo "missing $1 (and no env override). Refusing to send an unlabelled request." >&2
  exit 1
}

MARKER="$(read_secret .internal-marker "${INTERNAL_MARKER:-}")"

# Only read the stats token when a command actually needs it, so a missing
# stats token does not block an ordinary marked decode.
with_token() { read_secret .stats-token "${STATS_TOKEN:-}"; }

cmd="${1:-healthz}"
shift 2>/dev/null || true

case "$cmd" in
  healthz)
    curl -s -H "x-btx-internal: $MARKER" "$URL/healthz"
    ;;
  stats)
    curl -s -H "x-btx-internal: $MARKER" -H "x-stats-token: $(with_token)" "$URL/stats"
    ;;
  wallets)
    curl -s -H "x-btx-internal: $MARKER" -H "x-stats-token: $(with_token)" "$URL/wallets"
    ;;
  explain)
    [ $# -ge 1 ] || { echo "usage: ours.sh explain 0x<txhash>" >&2; exit 2; }
    curl -s -X POST "$URL/explain" \
      -H 'content-type: application/json' \
      -H "x-btx-internal: $MARKER" \
      -d "{\"tx_hash\":\"$1\"}"
    ;;
  mcp)
    [ $# -ge 1 ] || { echo "usage: ours.sh mcp 0x<txhash>" >&2; exit 2; }
    curl -s -X POST "$URL/mcp" \
      -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' \
      -H "x-btx-internal: $MARKER" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"explain_transaction\",\"arguments\":{\"tx_hash\":\"$1\"}}}"
    ;;
  raw)
    [ $# -ge 1 ] || { echo "usage: ours.sh raw /path [curl args...]" >&2; exit 2; }
    p="$1"; shift
    curl -s -H "x-btx-internal: $MARKER" -H "x-stats-token: $(with_token)" "$URL$p" "$@"
    ;;
  *)
    echo "unknown command: $cmd (try healthz|stats|wallets|explain|mcp|raw)" >&2
    exit 2
    ;;
esac
echo
