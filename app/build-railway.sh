#!/usr/bin/env bash
# Builds dist/index.railway.tsx (what gets pasted into the Railway Function) from index.tsx.
# Railway Functions cap source at 98,295 bytes; index.tsx is larger, so deploy this minified build.
# \uXXXX (and \xA0-\xFF) escapes of visible characters are turned back into literal characters because the deploy tool decodes them anyway,
# which keeps the deployed source byte-for-byte equal to this file.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
# The trailing export lines exist only for test/unit.ts; dropping them lets the minifier shorten those names too.
grep -v '^export ' index.tsx > /tmp/vouch-noexport.tsx
bun build /tmp/vouch-noexport.tsx --no-bundle --target=bun --minify --outfile=/tmp/vouch-min.js >/dev/null
{ printf '%s\n' "// Vouch v2 staging. BUILT FILE from index.tsx by build-railway.sh (bun build --minify; Railway caps source at 98,295 bytes). Edit index.tsx, not this."; cat /tmp/vouch-min.js; } > dist/index.railway.tsx
python3 -c "import re,sys;p=sys.argv[1];s=open(p,encoding='utf-8').read();open(p,'w',encoding='utf-8').write(re.sub(r'(?<!\\\\)\\\\(?:u([0-9A-Fa-f]{4})|x([A-Fa-f][0-9A-Fa-f]))',lambda m:(lambda c:c if c.isprintable() and not c.isspace() else m.group(0))(chr(int(m.group(1) or m.group(2),16))),s))" dist/index.railway.tsx
# End with a newline (the deploy tool keeps one when the source is pasted).
[ -z "$(tail -c1 dist/index.railway.tsx)" ] || echo >> dist/index.railway.tsx
bytes=$(wc -c < dist/index.railway.tsx); echo "dist/index.railway.tsx: $bytes bytes (limit 98295)"; [ "$bytes" -le 98295 ]
