# Contributing to cc-update-all

Thank you for your interest in contributing. This project is open to contributions of all kinds -- bug fixes, new tool support, documentation improvements, and more.

## How to Contribute

1. **Open an issue first** -- Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.md) or [feature request](.github/ISSUE_TEMPLATE/feature_request.md) template to describe what you want to do. This lets others weigh in before you start work.
2. **Fork the repo** and clone it locally.
3. **Create a feature branch** off `main` (`git checkout -b my-feature`).
4. **Make your changes** and add or update tests.
5. **Run `npm test`** -- all tests must pass before you open a PR.
6. **Open a pull request** -- Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md) and link the related issue.

External PRs require one approval before merging.

## Development Setup

No install step needed. The project has zero dependencies and requires Node.js >= 18.

```bash
git clone https://github.com/kianwoon/cc-update-all.git
cd cc-update-all
npm test
```

## Project Structure

- `cc-update-all.sh` -- Bash script for plugin marketplace updates
- `scripts-mcp/` -- Node.js modules for MCP server and extension checking
  - `scripts-mcp/lib/config-io.js` -- JSON config read/write utilities
  - `scripts-mcp/lib/npm-resolver.js` -- npm package version resolution
  - `scripts-mcp/lib/registry.js` -- tool registry and dispatch
  - `scripts-mcp/lib/reporter.js` -- update result formatting
  - `scripts-mcp/lib/marketplace-resolver.js` -- editor marketplace version resolution
  - `scripts-mcp/lib/tools/` -- per-tool modules (`cline.js`, `cursor.js`, `roo-code.js`, `cursor-extensions.js`, `windsurf-extensions.js`)
- `commands/` -- slash command definitions
- `docs/superpowers/` -- design specs and implementation plans

## Code Style

**Node.js:**
- `'use strict'` at the top of every file
- `const` only (no `var`, no `let`)
- `require()` for imports (no ESM)
- `node:test` and `node:assert/strict` for testing
- JSDoc comments on exported functions

**Bash:** Match the existing style in `cc-update-all.sh`.

## Testing

Tests are co-located with their source modules (`module.test.js` beside `module.js`).

```bash
npm test
```

All tests must pass. If you add a new tool module, add a corresponding test file.

## Commit Messages

Use [conventional commits](https://www.conventionalcommits.org/):

```
feat: add support for new editor
fix: resolve version comparison edge case
docs: update contributing guidelines
chore: bump version
```
