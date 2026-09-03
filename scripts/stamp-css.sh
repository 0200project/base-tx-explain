#!/bin/sh
# stamp-css.sh — put the current style.css hash on every stylesheet link.
#
# WHY THIS EXISTS. GitHub Pages serves assets with cache-control max-age=600.
# For ten minutes after a deploy, a returning visitor holds the OLD style.css
# and receives the NEW html. Most of the time that degrades into something
# survivable. On 2026-09-03 it did not: an <img> whose only size came from a
# stylesheet rendered at its full intrinsic width, and the founder saw a
# 1024px logo filling the About page.
#
# Two defences, and this is the one that removes the window entirely. The
# other is that every <img> now carries width/height attributes, so an
# unstyled image still has a box.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H="$(shasum -a 256 "$ROOT/site/assets/style.css" | cut -c1-8)"
python3 - "$ROOT" "$H" <<'PY'
import sys,glob,os,re
root,h=sys.argv[1],sys.argv[2]
n=0
for f in glob.glob(os.path.join(root,'site','**','*.html'),recursive=True):
    s=open(f,encoding='utf-8').read()
    o=re.sub(r'href="/assets/style\.css(\?v=[0-9a-f]+)?"', f'href="/assets/style.css?v={h}"', s)
    if o!=s: open(f,'w',encoding='utf-8').write(o); n+=1
print(f'  stamped ?v={h} on {n} file(s)')
PY
