# cc-update-all

Bulk-update all installed Claude Code plugin marketplaces and MCP server versions from within the CLI.

## Why?

Claude Code has no built-in command to update all your plugin marketplaces at once. Each marketplace must be refreshed individually — open settings, find the marketplace, click refresh, wait, repeat. When you have 5+ marketplaces installed, this gets tedious fast.

**cc-update-all** solves this with two slash commands:
- `/update-all-plugins` — one command, all marketplaces updated
- `/update-mcp-servers` — one command, all pinned MCP server versions checked and updated

It's also useful for multi-machine setups — keep your plugins and MCP servers in sync across machines without remembering which to refresh. Just run the commands and everything pulls the latest.

## Installation

```bash
# Add marketplace
claude plugin marketplace add kianwoon/cc-update-all

# Install plugin
claude plugin install update-all-plugins@cc-update-all --scope user
```

## Usage — Plugin Marketplaces

```
/update-all-plugins              Update all marketplaces with installed plugins
/update-all-plugins --dry-run    Preview changes without updating
/update-all-plugins --check      Check which marketplaces are behind (no update)
/update-all-plugins --only NAME  Update only a specific marketplace
/update-all-plugins --json       Output results as JSON
/update-all-plugins --force      Update even with dirty working trees
```

### How It Works

1. Reads `~/.claude/plugins/installed_plugins.json` to find which marketplaces have installed plugins
2. Cross-references `~/.claude/plugins/known_marketplaces.json` for git info
3. Runs `git fetch --all --prune` + `git pull --ff-only` on each git-backed marketplace
4. Skips directory-type marketplaces (local/npx)
5. Reports what was updated, skipped, and failed

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Update all git marketplaces with installed plugins |
| `--dry-run` | Show what would change, don't execute |
| `--check` | Check which are behind (exit 1 if outdated, 0 if current) |
| `--only NAME` | Update only the named marketplace |
| `--json` | Output summary as JSON |
| `--force` | Proceed even with dirty git repos |

## Usage — MCP Servers

```
/update-mcp-servers              Check and update all pinned MCP server versions
/update-mcp-servers --dry-run    Preview changes without updating
/update-mcp-servers --check      Check which versions are stale (no update)
/update-mcp-servers --tool NAME  Update only a specific tool
/update-mcp-servers --json       Output results as JSON
/update-mcp-servers --force      Skip confirmation prompt
```

### How It Works

1. Discovers MCP configurations for Cursor, Cline, and Roo Code
2. Extracts pinned npm package versions from each config
3. Queries the npm registry for the latest version of each package
4. Updates stale versions in-place with `.bak` backup safety
5. Reports what was updated, already current, and failed

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Check and update all pinned MCP server versions |
| `--dry-run` | Show what would change, don't modify configs |
| `--check` | Check which versions are stale (exit 1 if outdated, 0 if current) |
| `--tool NAME` | Update only the named tool/server |
| `--json` | Output summary as JSON |
| `--force` | Skip confirmation prompt |

## Dependencies

- `git` — required (plugin updates)
- `jq` — optional (safe JSON output; best-effort fallback when missing)
- `Node.js >= 18` — required (MCP server updates)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All updates successful |
| 1 | Partial failure (some targets failed) |
| 2 | Total failure or error |
