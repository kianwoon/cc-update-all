# cc-update-all

Bulk-update all installed Claude Code plugin marketplaces from within the CLI.

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
