#!/usr/bin/env bash
# =============================================================================
# bump-version.sh — Bump version in BOTH package.json and marketplace.json
#
# Usage: ./scripts/bump-version.sh <version>
#   e.g. ./scripts/bump-version.sh 1.3.8
#
# This ensures marketplace.json is always in sync with package.json,
# which is what the /plugin UI reads for version display.
# =============================================================================
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version>" >&2
  echo "  e.g. $0 1.3.8" >&2
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Validate version format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be semver (e.g. 1.3.8), got: $VERSION" >&2
  exit 1
fi

echo "Bumping version to $VERSION..."

# Bump package.json
if command -v jq &>/dev/null; then
  jq --arg v "$VERSION" '.version = $v' "$ROOT_DIR/package.json" > "${ROOT_DIR}/package.json.tmp" \
    && mv "${ROOT_DIR}/package.json.tmp" "$ROOT_DIR/package.json"
  echo "  Updated package.json"
else
  sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" "$ROOT_DIR/package.json"
  echo "  Updated package.json (sed)"
fi

# Bump .claude-plugin/marketplace.json
MARKETPLACE="$ROOT_DIR/.claude-plugin/marketplace.json"
if [[ -f "$MARKETPLACE" ]]; then
  if command -v jq &>/dev/null; then
    jq --arg v "$VERSION" '
      .metadata.version = $v |
      .plugins[].version = $v
    ' "$MARKETPLACE" > "${MARKETPLACE}.tmp" \
      && mv "${MARKETPLACE}.tmp" "$MARKETPLACE"
    echo "  Updated .claude-plugin/marketplace.json"
  else
    sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/g" "$MARKETPLACE"
    echo "  Updated .claude-plugin/marketplace.json (sed)"
  fi
else
  echo "  Warning: .claude-plugin/marketplace.json not found"
fi

# Summary
echo ""
echo "Done! Version bumped to $VERSION in:"
echo "  - package.json"
echo "  - .claude-plugin/marketplace.json"
echo ""
echo "Next steps:"
echo "  git add -A && git commit -m 'chore: bump version to $VERSION'"
echo "  git tag v$VERSION && git push origin main --tags"
