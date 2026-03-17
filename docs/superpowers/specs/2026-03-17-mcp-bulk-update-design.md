# MCP Server Bulk Update -- Design Spec

**Issue**: #1
**Date**: 2026-03-17
**Status**: Approved

---

## Overview

Add MCP server bulk-update capability to cc-update-all, supporting Cursor, Cline, Roo Code, and Windsurf. This is a new slash command (`/update-mcp-servers`) implemented as a Node.js script, keeping the existing bash script untouched.

## Motivation

AI coding tools store MCP server configs as JSON files with pinned npm versions. Keeping these up to date across multiple tools is tedious. One command checks all tools and updates stale versions.

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
│           ├── roo-code.js                 # ~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json
│           └── windsurf.js                 # ~/.windsurf/mcp.json (TBD -- research needed)
├── commands/
│   ├── update-all-plugins.md               # existing (unchanged)
│   └── update-mcp-servers.md               # new slash command
└── package.json                            # minimal -- zero runtime deps
```

### Module Boundaries

- **update-mcp.js** -- CLI arg parsing, delegates to registry
- **registry.js** -- scans tools/ dir, calls discover() on each, returns active tools
- **tools/*.js** -- each exports `{ name, discover(), parseMcpServers(configPath, rawJson), writeMcpServers(configPath, servers) }`
- **npm-resolver.js** -- takes package name, returns `{ current, latest }` from npm registry
- **config-io.js** -- reads JSON, creates .bak backup, writes back preserving key order
- **reporter.js** -- formats final output (text table or JSON)

No tool module depends on another tool module.

## Data Flow

1. User runs `/update-mcp-servers [--dry-run] [--tool cursor] [--check] [--json] [--force]`
2. `update-mcp.js` parses CLI args
3. `registry.discover()` probes each tool module's `discover()`, returns tools with config paths found on disk
4. For each active tool (or filtered by `--tool`):
   - `tool.parseMcpServers(configPath, rawJson)` extracts `{ name, command, args, env }` entries
   - Filters to npx-based servers only (`command === "npx"`)
5. For each npx server entry:
   - `npm-resolver.resolve(packageName)` queries `https://registry.npmjs.org/<package>/latest`
   - Returns `{ current, latest }`
6. Compare versions -- if `current !== latest` and version is pinned, mark for update
7. If not `--dry-run` and not `--check`:
   - `tool.writeMcpServers(configPath, updatedServers)` wraps in tool-specific schema
   - `config-io` creates .bak backup, writes JSON
8. `reporter.output(results)` formats as text table or JSON

## Version Extraction Logic

Shared logic lives in `npm-resolver.js`:

| args pattern | extracted package | pinned version | action |
|---|---|---|---|
| `["-y", "@pkg/name@1.2.3"]` | `@pkg/name` | `"1.2.3"` | Check update |
| `["-y", "@pkg/name"]` | `@pkg/name` | `null` | Skip (floating) |
| `["-y", "@pkg/name@latest"]` | `@pkg/name` | `null` | Skip (floating) |

## Tool Module Interface Contract

Each tool in `tools/` exports:

```js
module.exports = {
  name: 'cursor',
  discover() { /* returns configPath string or null */ },
  parseMcpServers(configPath, rawJson) { /* returns Array<{ name, command, args, env }> */ },
  writeMcpServers(configPath, servers) { /* returns full JSON object for config-io to write */ }
};
```

### Why separate parse and write?

Cline adds extra fields (`timeout`, `type`, `disabled`, `alwaysAllow`) that must be preserved during round-trip. The tool module owns the schema.

## Tool Config Paths

| Tool | Config Path | Schema wrapper |
|------|------------|----------------|
| Cursor | `~/.cursor/mcp.json` | `{ mcpServers: { [name]: { command, args, env } } }` |
| Cline | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | `{ mcpServers: { [name]: { command, args, env, timeout, type, disabled, alwaysAllow } } }` |
| Roo Code | `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | Same as Cline |
| Windsurf | `~/.windsurf/mcp.json` (TBD) | Likely same as Cursor |

Platform awareness: macOS paths differ from Linux/Windows -- each tool module handles its own path resolution.

## CLI Interface

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Check all tools, update pinned npm versions |
| `--dry-run` | Show what would change, don't write |
| `--check` | Report outdated only, exit 1 if any |
| `--tool NAME` | Only process named tool |
| `--json` | Output as JSON |
| `--force` | Skip mtime safety check |

### Text Output

```
Checking MCP servers across 3 tools...

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
    "cursor": { "status": "ok", "servers": [...] },
    "cline": { "status": "ok", "servers": [...] },
    "windsurf": { "status": "not_found" }
  },
  "summary": { "updated": 1, "current": 3, "skipped": 1, "failed": 0 }
}
```

## Error Handling

### Backup before write

- `config-io.js` creates `.bak` before any mutation
- If write fails, restore from `.bak`
- Only one backup level (overwrite previous .bak)

### npm registry failures

- Network timeout (5s default) -> mark as `check_failed`, continue
- Package not found -> mark as `not_found`, skip
- Rate limited (429) -> abort remaining, report partial

### Tool not installed

- `discover()` returns null -> silently omitted from results

### Malformed config

- Log warning, skip tool, mark as `parse_error`
- No .bak created for unreadable files

### Non-npx servers

- Silently skipped, counted in summary
- `command: "node"`, `command: "uvx"`, `command: "python"` etc.

### Concurrent writes

- Best-effort mtime check: read -> check mtime -> write -> check mtime again
- If mtime changed between read and write -> abort, warn user to close app

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All successful |
| 1 | Partial failure or `--check` found outdated |
| 2 | Total error |

## Dependencies

Zero runtime dependencies. Node.js built-ins only (`fs`, `path`, `https`). npm registry queried via raw HTTPS.

## Slash Command

New file `commands/update-mcp-servers.md` with `allowed-tools: Bash`, uses same `find` pattern to locate `scripts-mcp/update-mcp.js`.

## Out of Scope

- Extension updates (covered by issue #2)
- OpenClaw support (covered by issue #3)
- Windows support (future -- paths are macOS/Linux only for now)
- Auto-restart of AI coding tools after update
