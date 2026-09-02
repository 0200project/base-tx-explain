"""Parse one search surface's JSON for exact name/symbol collisions.

Usage: <json on stdin> | python3 name_collision.py <surface> <candidate>
Surfaces: jupiter | dexscreener | coingecko
Read-only. See scripts/name-collision.sh for what this instrument does and does not answer.
"""
import json
import sys


def money(v):
    try:
        return "${:,.0f}".format(float(v or 0))
    except (TypeError, ValueError):
        return "$?"


def main():
    surface, candidate = sys.argv[1], sys.argv[2].strip().lower()
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("  {:<12} UNREACHABLE".format(surface))
        return

    rows, exact = [], []

    if surface == "jupiter":
        rows = data if isinstance(data, list) else []
        exact = [t for t in rows
                 if (t.get("symbol") or "").strip().lower() == candidate
                 or (t.get("name") or "").strip().lower() == candidate]
        print("  {:<12} {:>3} hits | {} EXACT".format(surface, len(rows), len(exact)))
        for t in exact[:4]:
            print("      -> {} / {} | holders={} liq={} created={} {}".format(
                t.get("symbol"), t.get("name"), t.get("holderCount"),
                t.get("liquidity"), (t.get("createdAt") or "")[:10], t.get("id")))

    elif surface == "dexscreener":
        rows = data.get("pairs") or []
        exact = [x for x in rows
                 if ((x.get("baseToken") or {}).get("symbol") or "").strip().lower() == candidate
                 or ((x.get("baseToken") or {}).get("name") or "").strip().lower() == candidate]
        print("  {:<12} {:>3} pairs | {} EXACT".format(surface, len(rows), len(exact)))
        seen = set()
        for x in exact[:6]:
            b = x.get("baseToken") or {}
            key = (x.get("chainId"), b.get("address"))
            if key in seen:
                continue
            seen.add(key)
            print("      -> {} {} / {} | liq={} vol24={} {}".format(
                x.get("chainId"), b.get("symbol"), b.get("name"),
                money((x.get("liquidity") or {}).get("usd")),
                money((x.get("volume") or {}).get("h24")), b.get("address")))

    elif surface == "coingecko":
        rows = data.get("coins") or []
        exact = [x for x in rows
                 if (x.get("symbol") or "").strip().lower() == candidate
                 or (x.get("name") or "").strip().lower() == candidate]
        print("  {:<12} {:>3} coins | {} EXACT".format(surface, len(rows), len(exact)))
        for x in exact[:4]:
            print("      -> {} / {} | rank={} id={}".format(
                x.get("symbol"), x.get("name"), x.get("market_cap_rank"), x.get("id")))

    else:
        print("  unknown surface: {}".format(surface))


if __name__ == "__main__":
    main()
