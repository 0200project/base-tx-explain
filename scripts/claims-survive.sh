#!/bin/sh
# Does every load-bearing sentence still exist, and still on the page that carried it?
#
# A redesign rewrites markup. The sentences below were each expensive to get
# right -- several replaced a live falsehood -- and every one of them is the
# kind of line that disappears when a page is rebuilt, because it reads as
# copy rather than as a commitment. Nothing else checks for them: site-check.sh
# tests PATTERNS (a free-tier claim must name the /64), not PRESENCE.
#
# Snapshot taken 2026-09-04 from the live site at pages 74aef56.
# Run before and after any redesign. Regenerate deliberately, never to go green.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAN="$ROOT/scripts/claims-manifest.json"
[ -f "$MAN" ] || { echo "claims-survive: no manifest at $MAN"; exit 2; }

python3 - "$ROOT" "$MAN" <<'PY'
import json,sys,os
root,man=sys.argv[1],sys.argv[2]
claims=json.load(open(man))
missing=[];moved=[]
for text,meta in claims.items():
    found=[]
    for p in meta["pages"]:
        f=os.path.join(root,"site",("index.html" if p=="/" else p.rstrip("/")+"/index.html"))
        if not os.path.exists(f): f=os.path.join(root,"site",p)
        if os.path.exists(f) and text in open(f).read(): found.append(p)
    if not found: missing.append((text,meta))
    elif set(found)!=set(meta["pages"]): moved.append((text,meta,found))
if missing:
    print(f"  FAIL  {len(missing)} load-bearing claim(s) no longer appear anywhere:")
    for t,m in missing: print(f"        [{m['category']}] \"{t[:88]}\"\n              was on: {', '.join(m['pages'])}")
if moved:
    print(f"  WARN  {len(moved)} claim(s) left a page they were on:")
    for t,m,f in moved: print(f"        \"{t[:70]}\" gone from {set(m['pages'])-set(f)}")
if not missing and not moved:
    print(f"  ok    all {len(claims)} load-bearing claims present on their pages")
sys.exit(1 if missing else 0)
PY
