"""Extract every curl sample the site publishes, in its RENDERED form.

Rendered, not source: a reader copies what the browser shows. A <pre> once
baked 14 spaces of HTML indent into a homepage command that read fine in the
file. Tags stripped, entities unescaped, line-continuations joined.

Prints one sample per line as: <relative path>\t<command>
"""
import glob
import html
import os
import re
import sys

site = sys.argv[1]
seen, out = set(), []

files = sorted(glob.glob(os.path.join(site, '**', '*.html'), recursive=True))
files.append(os.path.join(site, 'llms.txt'))

for f in files:
    try:
        text = open(f, encoding='utf-8').read()
    except OSError:
        continue
    if f.endswith('.txt'):
        blocks = [text]
    else:
        blocks = [
            html.unescape(re.sub(r'<[^>]+>', '', m))
            for m in re.findall(r'<code[^>]*>(.*?)</code>', text, re.S)
        ]
    for block in blocks:
        if 'curl' not in block:
            continue
        joined = re.sub(r'\\\s*\n\s*', ' ', block)
        for line in joined.split('\n'):
            line = line.strip()
            if not line.startswith('curl'):
                continue
            if 'api.0200project.com' not in line:
                continue          # not a call against us; not our promise
            if line in seen:
                continue
            seen.add(line)
            out.append(os.path.relpath(f, site) + '\t' + line)

print('\n'.join(out))
