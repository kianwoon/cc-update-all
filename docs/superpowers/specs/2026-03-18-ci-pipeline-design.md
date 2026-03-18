# CI/CD Pipeline Design

**Date**: 2026-03-18
**Status**: Approved (v2 — reviewed)

## Overview

Add a GitHub Actions CI pipeline to `cc-update-all` (repo: `kianwoon/.claude`). The project currently has no CI/CD and no linting. This spec defines a single unified workflow with three parallel jobs: lint, test, and validate.

## Workflow

**File**: `.github/workflows/ci.yml` (`.github/` already exists with issue/PR templates)

### Triggers

- `push` to `main`
- `pull_request` targeting `main`

### Permissions

- `contents: read` only (least-privilege principle)

### Jobs (all parallel)

#### 1. lint

- `npm ci` to install dependencies
- `npx biome check .` — runs linter + formatter check
- Uses project-level `biome.json` config
- `noConsoleLog` rule disabled (this is a CLI tool, console output is intentional)

#### 2. test

- `npm ci` then `npm test`
- Runs all 12 test suites via `node --test` (Node >= 18)
- Tests located under `scripts-mcp/`

#### 3. validate

- Check no `.tmp` files tracked in git (preventive — none exist currently)
- Validate `package.json` is parseable JSON

## Biome Configuration

**File**: `biome.json`

| Setting | Value |
|---|---|
| Indent | 2 spaces |
| Quotes | Single |
| Semicolons | Required |
| Line width | 120 |
| Linter | Recommended, with `noConsoleLog: off` |
| Ignore | `node_modules/`, `*.bundle.mjs`, `bun.lock` |

> Note: `*.bundle.mjs` and `bun.lock` are excluded as preventive ignores for known edge cases.

## File Changes

| File | Action |
|---|---|
| `.github/workflows/ci.yml` | Create |
| `biome.json` | Create |
| `package.json` | Modify — add `@biomejs/biome` to devDependencies |

## Exclusions

These are excluded from both linting and CI:

- `node_modules/` — dependencies
- `*.bundle.mjs` — pre-built bundles (if present)
- `bun.lock` — alternative lockfile (project uses npm)

## Branch Protection (Out of Scope)

For PRs to actually be blocked, branch protection rules must be configured in GitHub repo settings (Settings → Branches → Add rule for `main` → Require status checks to pass). This is a manual repo-level configuration step, not part of this spec.

## Success Criteria

1. All three jobs pass on a clean `main` push
2. Biome config matches existing code style (2-space indent, single quotes, semicolons)
3. Zero false positives from validate job on current `main`
4. No `console.log` false positives from lint job on CLI source files
