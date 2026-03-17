# cc-update-all

<img width="592" height="239" alt="image" src="https://github.com/user-attachments/assets/95cf426d-5063-4f42-9e3b-0f2a03e6f2b2" />


Bulk-update Claude Code plugin marketplaces, MCP server versions, and editor extensions from within the CLI.

## Why?

Claude Code has no built-in command to update all your plugin marketplaces at once. Each marketplace must be refreshed individually — open settings, find the marketplace, click refresh, wait, repeat. When you have 5+ marketplaces installed, this gets tedious fast.

**cc-update-all** solves this with three slash commands:
- `/update-all-plugins` — one command, all marketplaces updated
- `/update-mcp-servers` — one command, all pinned MCP server versions checked and updated
- `/update-extensions` — one command, check which Cursor and Windsurf extensions are outdated

It's also useful for multi-machine setups — keep your plugins and MCP servers in sync across machines without remembering which to refresh. Just run the commands and everything pulls the latest.

## Installation

### Claude Code (Plugin)

```bash
# Add marketplace
claude plugin marketplace add kianwoon/cc-update-all

# Install plugin
claude plugin install update-all-plugins@cc-update-all --scope user
```

### Other Tools (Git Clone)

The MCP and extension check scripts work standalone from any terminal. Requires Node.js >= 18.

```bash
git clone https://github.com/kianwoon/cc-update-all.git
cd cc-update-all

# Check MCP server versions
node scripts-mcp/update-mcp.js

# Check extension versions
node scripts-mcp/update-extensions.js

# See all flags
node scripts-mcp/update-mcp.js --help
node scripts-mcp/update-extensions.js --help
```

The plugin marketplace update (`cc-update-all.sh`) is Claude Code-specific. The MCP and extension features work across all supported tools regardless of how they're installed.

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

1. Discovers MCP configurations for [Cursor](https://cursor.sh), [Cline](https://cline.autodev.com), and [Roo Code](https://github.com/RooVetGit/Roo-Code)
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

## Supported Tools

**Vibe Coding / AI Coding Tools:**

| Tool | MCP Updates | Extension Updates |
|------|:-----------:|:-----------------:|
| Cursor | ✓ | ✓ |
| Cline | ✓ | — |
| Roo Code | ✓ | — |
| Windsurf | — | ✓ |

Both MCP and extension features use a shared plugin-architecture with auto-discovered tool modules. Adding support for new editors requires only dropping a new module into `scripts-mcp/lib/tools/`.

## Usage — Extensions

```
/update-extensions              Check extension versions across Cursor and Windsurf
/update-extensions --tool NAME  Only process named tool (cursor-extensions, windsurf-extensions)
/update-extensions --json       Output results as JSON
/update-extensions --include-prerelease  Consider pre-release versions as latest
```

### How It Works

1. Discovers `extensions.json` for Cursor (`~/.cursor/extensions/`) and Windsurf (`~/.windsurf/extensions/`)
2. Extracts gallery-sourced extensions only (skips .vsix and unknown sources)
3. Queries the VS Code Marketplace API in a single batch request
4. Compares installed versions against latest — reports outdated extensions
5. Check-only mode — updates must be applied manually through the editor's extension panel

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Check all tools, report outdated extensions |
| `--tool NAME` | Only process named tool |
| `--json` | Output as JSON |
| `--include-prerelease` | Consider pre-release versions |

## Dependencies

- `git` — required (plugin updates)
- `jq` — optional (safe JSON output; best-effort fallback when missing)
- `Node.js >= 18` — required (MCP server + extension updates)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All updates successful |
| 1 | Partial failure (some targets failed) |
| 2 | Total failure or error |
