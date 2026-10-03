#!/usr/bin/env bash
# Build the MCP Bundle (.mcpb) for the official MCP Registry / Claude Desktop.
# Usage: mcp/build_mcpb.sh            → mcp/dist/noddle-draw.mcpb (+ prints sha256)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/dist"; stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$out" "$stage/server"
cp "$here/mcpb/manifest.json" "$stage/manifest.json"
cp "$here/noddle_mcp.py" "$stage/server/noddle_mcp.py"
cp "$here/README.md" "$stage/README.md"
if [ -f "$here/../web/public/logo-512.png" ]; then cp "$here/../web/public/logo-512.png" "$stage/icon.png"; fi
ver=$(python3 -c "import json;print(json.load(open('$stage/manifest.json'))['version'])")
pyver=$(grep -m1 '^__version__' "$here/noddle_mcp.py" | cut -d'"' -f2)
[ "$ver" = "$pyver" ] || { echo "manifest version $ver != noddle_mcp.py $pyver" >&2; exit 1; }
rm -f "$out/noddle-draw.mcpb"
(cd "$stage" && zip -q -X -r "$out/noddle-draw.mcpb" .)
openssl dgst -sha256 "$out/noddle-draw.mcpb" | awk '{print $NF}'
