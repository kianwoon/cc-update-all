# MCP Server Bulk Update -- Design Spec

**Issue**: #1
**Date**: 2026-03-17
**Status**: Draft

---

## Overview

Add MCP server bulk-update capability to cc-update-all, supporting Cursor, Cline, and Roo Code. This is a new slash command (`/update-mcp-servers`) implemented as a Node.js script, keeping the existing bash script untouched.

## Motivation

AI coding tools store MCP server configs as JSON files with pinned npm versions. Keeping these up to date across multiple tools is tedious. One command checks all tools and updates stale versions.

## Prerequisites

- **Node.js >= 18.0.0** — required for stable `fs/promises` and `fetch` (global in Node 18+)
- **File I/O**: Synchronous (`fs.readFileSync`, `fs.writeFileSync`) — appropriate for a CLI tool that runs sequentially and exits

## Architecture: Tool Registry Pattern

### File Structure

```
cc-update-all/
├── scripts/
│   └── cc-update-all.sh                    # existing (unchanged)
├── scripts-mcp/                            # new directory
│   ├── update-mcp.js                       # entry point + CLI parser
│   └── lib/
│       ├── registry.js                     # discovers & loads tool modules
│       ├── npm-resolver.js                 # queries npm registry for latest versions
│       ├── config-io.js                    # reads/writes JSON configs with backup
│       ├── reporter.js                     # formats output (text, JSON)
│       └── tools/
│           ├── cursor.js                   # ~/.cursor/mcp.json
│           ├── cline.js                    # ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json
│           └── roo-code.js                 # ~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json
├── commands/
│   ├── update-all-plugins.md               # existing (unchanged)
│   └── update-mcp-servers.md               # new slash command
└── package.json                            # minimal -- zero runtime deps
```

Note: Windsurf is excluded from v1 — its MCP config path is not well-documented and may be GUI-only. Adding Windsurf later requires only one new file in `tools/`.

### Module Boundaries

- **update-mcp.js** — CLI arg parsing, delegates to registry
- **registry.js** — scans tools/ dir, calls discover() on each, returns active tools
- **tools/*.js** — each exports `{ name, discover(), parseMcpServers(configPath, rawJson), writeMcpServers(servers) }`
- **npm-resolver.js** — takes package name, returns `{ current, latest }` from npm registry
- **config-io.js** — reads JSON, creates .bak backup, writes back preserving key order
- **reporter.js** — formats final output (text table or JSON)

No tool module depends on another tool module.

## Data Flow

1. User runs `/update-mcp-servers [--dry-run] [--tool cursor] [--check] [--json] [--force]`
2. `update-mcp.js` parses CLI args, validates `--tool NAME` against registry
3. `registry.discover()` probes each tool module's `discover()`, returns tools with config paths found on disk
4. For each active tool (or filtered by `--tool`):
   - `tool.parseMcpServers(configPath, rawJson)` extracts normalized server entries
   - Filters to npx-based servers only (`command === "npx"`)
5. For each npx server entry:
   - `npm-resolver.resolve(packageName)` queries `https://registry.npmjs.org/<package>/latest`
   - Returns `{ current, latest }`
6. Compare versions — if `current !== latest` and version is pinned, mark for update
7. If not `--dry-run` and not `--check`:
   - Mutate the pinned version in the server entry's `args` array
   - `tool.writeMcpServers(servers)` wraps the **complete** server array in tool-specific schema
   - `config-io` creates .bak backup, records mtime, writes JSON, verifies mtime
8. `reporter.output(results)` formats as text table or JSON

### Round-Trip Data Contract

`name` in parsed arrays is the **MCP server key** from the JSON (e.g., `"my-server"`), NOT the npm package name. The npm package name is extracted separately from `args`.

**Example — Cursor round-trip:**

Input (`~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "anthropic": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server@1.2.3"],
      "env": {}
    },
    "local-tool": {
      "command": "node",
      "args": ["/path/to/tool.js"]
    }
  }
}
```

After `parseMcpServers()`:
```js
[
  { key: "anthropic", command: "npx", args: ["-y", "@anthropic/mcp-server@1.2.3"], env: {} },
  { key: "local-tool", command: "node", args: ["/path/to/tool.js"], env: {} }
]
```

After version update (anthropic bumped to 1.3.0):
```js
[
  { key: "anthropic", command: "npx", args: ["-y", "@anthropic/mcp-server@1.3.0"], env: {} },
  { key: "local-tool", command: "node", args: ["/path/to/tool.js"], env: {} }
]
```

`writeMcpServers()` receives the **complete** array (both entries), wraps it:
```json
{
  "mcpServers": {
    "anthropic": { "command": "npx", "args": ["-y", "@anthropic/mcp-server@1.3.0"], "env": {} },
    "local-tool": { "command": "node", "args": ["/path/to/tool.js"], "env": {} }
  }
}
```

`writeMcpServers()` always receives the full array — not just changed entries. The tool module is responsible for merging the normalized array back into its JSON schema format.

## Version Extraction Logic

Shared logic lives in `npm-resolver.js`:

| args pattern | extracted package | pinned version | action |
|---|---|---|---|
| `["-y", "@pkg/name@1.2.3"]` | `@pkg/name` | `"1.2.3"` | Check update |
| `["-y", "@pkg/name"]` | `@pkg/name` | `null` | Skip (floating) |
| `["-y", "@pkg/name@latest"]` | `@pkg/name` | `null` | Skip (floating) |
| `["-y", "github:user/repo"]` | N/A | N/A | Skip (git URL, not npm) |
| `["-y", "@pkg/name@1.2.3/sub/path"]` | `@pkg/name` | `"1.2.3"` | Check update (subpath discarded) |

### Non-npm sources

- Git-based URLs (`github:user/repo`, `https://...`) are skipped with `not_npm` status
- Private/scoped packages that 404 from npmjs.org are skipped gracefully (`not_found`)
- Subpath patterns extract the base package name and version, discarding the subpath

## Tool Module Interface Contract

Each tool in `tools/` exports:

```js
module.exports = {
  name: 'cursor',                                    // human-readable, used in --tool flag

  discover() {
    // Returns config path string if tool is installed, or null if not found.
    // Platform-aware: expand ~, handle macOS vs Linux paths.
    // Returns: string | null
  },

  parseMcpServers(configPath, rawJson) {
    // Takes file path + parsed JSON object.
    // Extracts MCP server entries from the tool's specific JSON schema.
    // Returns: Array<{ key, command, args, env, ...extraFields }>
    //   - key: the MCP server name key from the JSON (not npm package name)
    //   - extraFields: any tool-specific fields to preserve (e.g., timeout, disabled)
  },

  writeMcpServers(servers) {
    // Takes the COMPLETE normalized server array (unchanged + changed entries).
    // Wraps them in the tool's JSON schema.
    // Extra fields from parseMcpServers() must be preserved in output.
    // Returns: full JSON object (for config-io to write)
  }
};
```

### Why separate parse and write?

Cline adds extra fields (`timeout`, `type`, `disabled`, `alwaysAllow`) that must be preserved during round-trip. The tool module owns the schema — `config-io` just writes whatever JSON it receives.

## Tool Config Paths

| Tool | Config Path | Schema wrapper |
|------|------------|----------------|
| Cursor | `~/.cursor/mcp.json` | `{ mcpServers: { [key]: { command, args, env } } }` |
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `{ mcpServers: { [key]: { command, args, env, timeout, type, disabled, alwaysAllow } } }` |
| Roo Code | `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | Same as Cline |

Platform awareness: macOS paths differ from Linux/Windows — each tool module handles its own path resolution via `os.homedir()` and `process.platform`.

## CLI Interface

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Check all tools, update pinned npm versions |
| `--dry-run` | Show what would change, don't write |
| `--check` | Report outdated only, exit 1 if any |
| `--tool NAME` | Only process named tool. If NAME not found among discovered tools, exit 2 and list available tools. |
| `--json` | Output as JSON |
| `--force` | Skip mtime safety check, write anyway |

### Text Output

```
Checking MCP servers across 2 tools...

  cursor
    [UPDATED]   @anthropic/mcp-server   1.2.3 -> 1.3.0
    [CURRENT]   @modelcontextprotocol/server-github
    [SKIPPED]   local-tool (not npx-based)

  cline
    [CURRENT]   @anthropic/mcp-server   1.3.0

========== SUMMARY ==========
  Updated: 1  |  Current: 3  |  Skipped: 1  |  Failed: 0
```

### JSON Output

```json
{
  "tools": {
    "cursor": {
      "status": "ok",
      "configPath": "/Users/you/.cursor/mcp.json",
      "servers": [
        {
          "key": "anthropic",
          "package": "@anthropic/mcp-server",
          "status": "updated",
          "current": "1.2.3",
          "latest": "1.3.0"
        },
        {
          "key": "github",
          "package": "@modelcontextprotocol/server-github",
          "status": "current",
          "current": null,
          "latest": "2.1.0"
        },
        {
          "key": "local-tool",
          "status": "skipped_non_npx"
        }
      ]
    },
    "cline": {
      "status": "ok",
      "configPath": "/Users/you/Library/Application Support/Code/User/globalStorage/...",
      "servers": [
        {
          "key": "anthropic",
          "package": "@anthropic/mcp-server",
          "status": "current",
          "current": null,
          "latest": "1.3.0"
        }
      ]
    }
  },
  "summary": { "updated": 1, "current": 3, "skipped": 1, "failed": 0 }
}
```

Per-server status values: `updated`, `current`, `skipped_non_npx`, `skipped_floating`, `check_failed`, `not_found`, `not_npm`

## Error Handling

### Backup before write

- `config-io.js` creates `.bak` before any mutation
- If write fails, restore from `.bak`
- Only one backup level (overwrite previous .bak)
- **Design tradeoff**: single-level `.bak` means only the last state is recoverable. This is intentional for simplicity. Users who need version history should use git or filesystem snapshots on the config directory.

### npm registry failures

- Network timeout (5s default) → mark server as `check_failed`, continue to next server
- Package not found on npmjs.org → mark as `not_found`, skip (covers private registries gracefully)
- Rate limited (429) → abort remaining checks, report partial results

### Tool not installed

- `discover()` returns null → silently omitted from results
- Tool does not appear in output at all (not even as `not_found`)

### Malformed config

- Log warning, skip tool, mark as `parse_error`
- No `.bak` created for unreadable files

### Non-npx servers

- Silently skipped, counted in summary under `skipped`
- `command: "node"`, `command: "uvx"`, `command: "python"`, etc.

### Concurrent writes (mtime safety check)

Sequence: (1) read file, (2) record `fs.statSync(path).mtimeMs`, (3) perform npm checks, (4) re-stat file, (5) if `mtimeMs` changed, abort and warn user to close the app, (6) write file, (7) verify write succeeded.

If `--force` is passed, skip the mtime check at step 4-5.

**Note**: This is best-effort. NTFS/HFS+ have 1-second mtime resolution, so very fast successive writes may not be caught. This is acceptable — the `.bak` provides a recovery path.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All checks/updates successful, or some updated with no failures |
| 1 | Partial failure (some servers failed) OR `--check` found outdated servers |
| 2 | Total error (bad args, no tools found, `--tool NAME` not found) |

## Dependencies

Zero runtime dependencies. Node.js >= 18.0.0 built-ins only (`fs`, `path`, `https`). npm registry queried via raw HTTPS (no `fetch`, no `axios`).

## Slash Command

New file `commands/update-mcp-servers.md`:

```markdown
---
description: Bulk-update MCP servers across Cursor, Cline, and Roo Code
argument-hint: [--dry-run] [--check] [--tool NAME] [--json] [--force]
allowed-tools: Bash
---

Run the MCP update script to check and update MCP server versions across AI coding tools. The script discovers MCP configs for installed tools and updates pinned npm versions.

Find the script in the plugin cache and execute it with any user-provided arguments. The script is located somewhere under `~/.claude/plugins/cache/` — use `find` to locate it if needed. Do NOT hardcode the cache path; discover it dynamically.

​```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts-mcp/update-mcp.js" 2>/dev/null | head -1 | xargs -I{} node {} $ARGUMENTS
​```

After the script completes, present the summary output to the user. If any MCP servers were updated, remind the user to restart the relevant AI coding tool to pick up changes.
```

## Out of Scope

- Extension updates (covered by issue #2)
- OpenClaw support (covered by issue #3)
- Windsurf support — MCP config path is not well-documented; will be added as a single `tools/windsurf.js` file once confirmed
- Windows support (future — paths are macOS/Linux only for now)
- Auto-restart of AI coding tools after update
