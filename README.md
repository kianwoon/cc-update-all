# cc-update-all

Bulk-update all installed Claude Code plugin marketplaces from within the CLI.

## Why?

Claude Code has no built-in command to update all your plugin marketplaces at once. Each marketplace must be refreshed individually — open settings, find the marketplace, click refresh, wait, repeat. When you have 5+ marketplaces installed, this gets tedious fast.

**cc-update-all** solves this by running `/cc-update-all` inside Claude Code. One command, all marketplaces updated.

It's also useful for multi-machine setups — keep your plugins in sync across machines without remembering which marketplaces to refresh. Just run the command and everything pulls the latest.

## Installation

```bash
# Add marketplace
claude plugin marketplace add kianwoon/cc-update-all

# Install plugin
claude plugin install cc-update-all@cc-update-all --scope user
```

## Usage

```
/cc-update-all              Update all marketplaces with installed plugins
/cc-update-all --dry-run    Preview changes without updating
/cc-update-all --only NAME  Update only a specific marketplace
/cc-update-all --json       Output results as JSON
/cc-update-all --force      Update even with dirty working trees
```

## How It Works

1. Reads `~/.claude/plugins/installed_plugins.json` to find which marketplaces have installed plugins
2. Cross-references `~/.claude/plugins/known_marketplaces.json` for git info
3. Runs `git fetch --all --prune` + `git pull --ff-only` on each git-backed marketplace
4. Skips directory-type marketplaces (local/npx)
5. Reports what was updated, skipped, and failed

## Dependencies

- `git` — required
- `jq` — optional (enhanced JSON parsing, has fallback)

## Flags

| Flag | Behavior |
|------|----------|
| (default) | Update all git marketplaces with installed plugins |
| `--dry-run` | Show what would change, don't execute |
| `--only NAME` | Update only the named marketplace |
| `--json` | Output summary as JSON |
| `--force` | Proceed even with dirty git repos |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All updates successful |
| 1 | Partial failure (some marketplaces failed) |
| 2 | Total failure or error |
