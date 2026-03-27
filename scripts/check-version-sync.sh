#!/usr/bin/env bash
# Check that package.json and marketplace.json versions are in sync
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PKG_VERSION=""
MP_VERSION=""

if command -v jq &>/dev/null; then
  PKG_VERSION=$(jq -r '.version' "$ROOT_DIR/package.json" 2>/dev/null)
  MP_VERSION=$(jq -r '.metadata.version' "$ROOT_DIR/.claude-plugin/marketplace.json" 2>/dev/null)
else
  PKG_VERSION=$(grep -oE '"version"\s*:\s*"[^"]+"' "$ROOT_DIR/package.json" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
  MP_VERSION=$(grep -oE '"version"\s*:\s*"[^"]+"' "$ROOT_DIR/.claude-plugin/marketplace.json" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
fi

if [[ "$PKG_VERSION" != "$MP_VERSION" ]]; then
  echo "ERROR: Version mismatch!" >&2
  echo "  package.json:    $PKG_VERSION" >&2
  echo "  marketplace.json: $MP_VERSION" >&2
  echo "" >&2
  echo "Run ./scripts/bump-version.sh $PKG_VERSION to fix." >&2
  exit 1
fi

echo "OK: Versions in sync ($PKG_VERSION)"
exit 0
