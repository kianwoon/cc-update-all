#!/usr/bin/env bash
# Pre-commit hook: ensure package.json and marketplace.json versions match
# Install: cp scripts/pre-commit-check-versions.sh .git/hooks/pre-commit
set -euo pipefail

# Find repo root via git so this works whether symlinked or copied into .git/hooks/
ROOT_DIR="$(git rev-parse --show-toplevel)"

exec "$ROOT_DIR/scripts/check-version-sync.sh"
