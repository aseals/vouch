#!/usr/bin/env bash
# Builds dist/index.railway.tsx (what gets pasted into the Railway Function) from index.tsx.
# Railway Functions cap source at 98,295 bytes; index.tsx is larger, so deploy this minified build.
# \uXXXX escapes are turned back into literal characters because the deploy tool decodes them anyway,
# which keeps the deployed source byte-for-byte equal to this file.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
bun build index.tsx --no-bundle --target=bun --minify-whitespace --minify-syntax --outfile=/tmp/vouch-min.js >/dev/null
{ printf '%s\n' "// Vouch v2 staging. BUILT FILE: generated from index.tsx with \`bun build index.tsx --no-bundle --target=bun --minify-whitespace --minify-syntax\` because Railway Functions cap source at 98,295 bytes. Edit index.tsx, not this."; cat /tmp/vouch-min.js; } > dist/index.railway.tsx
python3 -c "import re,sys;p=sys.argv[1];s=open(p,encoding='utf-8').read();open(p,'w',encoding='utf-8').write(re.sub(r'(?<!\\\\)\\\\u([0-9A-Fa-f]{4})',lambda m:chr(int(m.group(1),16)),s))" dist/index.railway.tsx
bytes=$(wc -c < dist/index.railway.tsx); echo "dist/index.railway.tsx: $bytes bytes (limit 98295)"; [ "$bytes" -le 98295 ]
