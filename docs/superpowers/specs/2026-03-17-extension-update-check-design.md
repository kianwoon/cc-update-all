# Extension Update Checker -- Design Spec

**Issue**: #2
**Date**: 2026-03-17
**Status**: Draft

---

## Overview

Add extension update checking for Cursor and Windsurf (VS Code fork editors). A new `/update-extensions` slash command reads `extensions.json` from each editor, queries the VS Code Marketplace API for latest versions, and reports which extensions are outdated.

This is check-only by default. Cursor and Windsurf don't expose a CLI for extension installation, so auto-install is out of scope.

## Prerequisites

- **Node.js >= 18.0.0** — already required by the MCP update feature
- **Network access** — queries `marketplace.visualstudio.com` API (no auth needed for public queries)
- **Zero new runtime dependencies** — uses Node.js built-in `https` module

## Scope

### In scope
- Cursor extension checking (`~/.cursor/extensions/extensions.json`)
- Windsurf extension checking (`~/.windsurf/extensions/extensions.json`)
- Gallery-sourced extensions only (source: `"gallery"`)
- Check-only mode (no writes to config files)

### Out of scope
- Roo Code extensions (Roo Code is an AI agent, not a VS Code fork editor in the extension sense)
- Auto-installation of extensions (no CLI for `--install-extension` in these editors)
- .vsix file downloads
- Per-project extension overrides (`.vscode/extensions.json`)
- Non-gallery extensions (source: `"vsix"`, source: `"undefined"`)
- Windows support (paths are macOS/Linux only, same as MCP feature)
- Offline/cache mode (future enhancement)
- Extension deprecation warnings (future enhancement)

## Architecture

### File Structure

```
scripts-mcp/lib/
  marketplace-resolver.js          # NEW: batch Marketplace API queries
  marketplace-resolver.test.js     # NEW: Marketplace resolver tests
  tools/
    cursor.js                    # existing (unchanged)
    cursor.test.js               # existing (unchanged)
    cline.js                     # existing (unchanged)
    cline.test.js                # existing (unchanged)
    roo-code.js                  # existing (unchanged)
    roo-code.test.js             # existing (unchanged)
    cursor-extensions.js         # NEW: Cursor extensions.json handler
    cursor-extensions.test.js    # NEW: Cursor extensions tests
    windsurf-extensions.js        # NEW: Windsurf extensions.json handler
    windsurf-extensions.test.js   # NEW: Windsurf extensions tests
scripts-mcp/
  update-extensions.js           # NEW: CLI entry point
  update-extensions.test.js       # NEW: CLI tests
```

### Module Boundaries

- **marketplace-resolver.js** — Marketplace API interaction only. Takes array of extension IDs, returns latest versions.
- **tools/cursor-extensions.js** — reads Cursor's `extensions.json`, extracts gallery extensions.
- **tools/windsurf-extensions.js** — reads Windsurf's `extensions.json`, extracts gallery extensions.
- **update-extensions.js** — CLI parsing, orchestrates discovery + checking + reporting.
- **registry.js** — loads extension tools alongside MCP tools automatically (no code change needed — just drop new files in `tools/`). The CLI entry point filters discovered tools by duck-typing: `typeof tool.parseExtensions === 'function'` selects extension tools, `typeof tool.parseMcpServers === 'function'` selects MCP tools.
- **reporter.js** — reused for text/JSON output formatting. Extension tool results must align to the existing MCP result schema for zero-change reuse (see Result Schema section below).

### Result Schema (aligned with reporter.js)

To reuse `reporter.js` without modification, extension tool results use the same schema as MCP results:

```js
var toolResult = {
  status: 'ok',           // 'ok' | 'parse_error' | 'api_error'
  configPath: '~/.cursor/extensions/extensions.json',
  servers: [              // MUST use 'servers' key (reporter iterates tool.servers)
    {
      key: 'ms-python.vscode-pylance',    // extension ID
      package: 'ms-python.vscode-pylance', // same as key (reporter uses package || key)
      current: '2024.8.1',                 // installed version (reporter uses server.current)
      latest: '2026.1.101',               // latest Marketplace version
      status: 'updated'                    // 'updated' | 'current' | 'not_found' | 'check_failed'
    }
  ]
};
```

Status strings map directly to reporter's `_STATUS_LABELS`:
- `updated` → `UPDATED`
- `current` → `CURRENT`
- `not_found` → `SKIPPED` (already defined in reporter)
- `check_failed` → `FAILED` (already defined in reporter)

Non-gallery extensions are excluded from the `servers` array entirely. Their count is tracked in a separate `skippedNonGallery` field on the tool result for JSON output only (reporter ignores unknown fields).

### Why a separate CLI entry point?

Extension updates and MCP updates share infrastructure (registry, reporter, config-io) but have fundamentally different orchestration logic. Extension checking is read-only with no write path. MCP updates are read-then-write with version mutation. Separate entry points keep each simple and focused.

## Data Flow

1. User runs `/update-extensions [--tool NAME] [--json] [--include-prerelease]`
2. `update-extensions.js` calls `registry.discover()`, then filters to extension tools only:
   ```js
   var discovered = registry.discover().filter(function (t) {
     return typeof t.tool.parseExtensions === 'function';
   });
   ```
3. For each discovered extension tool:
   - `tool.parseExtensions(configPath, rawJson)` extracts `{ key, id, version, pinned }[]` for gallery-sourced extensions
   - `marketplaceResolver.resolveLatest(ids[], { includePreRelease })` — single batch POST to Marketplace API
   - Compare installed vs. latest → build result entries with `{ key, package: id, current: version, latest, status }`
   - Non-gallery extensions are counted in `skippedNonGallery` but not added to `servers` array
4. `reporter.formatText/formatJson(results)` formats output
5. Exit 0 if all checks succeeded, exit 1 if any failures, exit 2 if total error

### Extension Entry Schema (from extensions.json)

```json
{
  "identifier": {
    "id": "ms-python.vscode-pylance",
    "uuid": "364d2426-116a-433a-a5d8-a5098dc3afbd"
  },
  "version": "2024.8.1",
  "location": { "path": "/Users/you/.cursor/extensions/ms-python.vscode-pylance-2024.8.1" },
  "metadata": {
    "installedTimestamp": 1741672652266,
    "pinned": false,
    "source": "gallery",
    "id": "364d2426-116a-433a-a5d8-a5098dc3afbd",
    "publisherId": "998b010b-e2af-44a5-a6cd-0b5fd3b9b6f8",
    "publisherDisplayName": "ms-python",
    "targetPlatform": "undefined"
  }
}
```

Fields used by the extension checker:
- `identifier.id` — extension identifier (used to query Marketplace API)
- `version` — installed version string (compared against latest)
- `metadata.source` — `"gallery"` or `"vsix"` (only gallery is checked)
- `metadata.pinned` — informational only (included in output)

### Tool Module Interface Contract

Each extension tool in `tools/` exports:

```js
module.exports = {
  name: 'cursor-extensions',

  discover() {
    // Returns config path string if tool is installed, or null if not found.
    // Returns: string | null
  },

  parseExtensions(configPath, rawJson) {
    // Takes file path + parsed JSON object.
    // Extracts gallery-sourced extension entries only.
    // Returns: Array<{ key: string, id: string, version: string, pinned: boolean }>
  }
};
```

Note: No `writeExtensions()` method — this feature is check-only.

### Marketplace API Interaction

**Endpoint:** `POST https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`

**Headers:**
```
Content-Type: application/json
Accept: application/json;api-version=3.0-preview.1
```

**Request body (batch query):**
```json
{
  "filters": [{
    "criteria": [
      { "filterType": 7, "value": "ms-python.vscode-pylance" },
      { "filterType": 7, value": "geddski.macros" },
      { "filterType": 12, "value": "Microsoft.VisualStudio.Code" }
    ],
    "pageCount": 1,
    "pageSize": 1000
  }],
  "flags": 976
}
```

**Key filter types:**
- `filterType: 7` — ExtensionName (accepts `publisher.name` or just `name`)
- `filterType: 12` — Target (always `Microsoft.VisualStudio.Code`)

**Key flags:**
- `8` — IncludeLatestVersionOnly (default, returns 1 version per extension)
- `768` — ExcludeNonValidated

**Response (truncated):**
```json
{
  "results": [{
    "extensions": [{
      "extensionName": "vscode-pylance",
      "publisher": { "publisherName": "ms-python" },
      "versions": [{ "version": "2026.1.101" }],
      "lastUpdated": "174..."
    }]
  }]
}
```

**Mapping:**
- Input: `extension.identifier.id` (e.g., `ms-python.vscode-pylance`)
- Output: `extension.versions[0].version` (e.g., `2026.1.101`)

### Registry Integration

The existing `registry.js` automatically loads any `.js` file in `scripts-mcp/lib/tools/` that exports the standard interface. Extension tools (`cursor-extensions.js`, `windsurf-extensions.js`) will be discovered alongside MCP tools (`cursor.js`, `cline.js`, `roo-code.js`).

The CLI entry point filters to extension tools only:
```js
var allDiscovered = registry.discover();
var extensionTools = allDiscovered.filter(function (t) {
  return typeof t.tool.parseExtensions === 'function';
});
```

For `--tool NAME` validation, the CLI filters from `extensionTools` (not all tools), so `--tool cursor` would fail (no extension tool named "cursor"). Valid values are `cursor-extensions` and `windsurf-extensions`.

## CLI Interface

### Flags

| Flag | Behavior |
|------|----------|
| (default) | Check all tools, report outdated extensions |
| `--tool NAME` | Only process named tool (cursor-extensions, windsurf-extensions) |
| `--json` | Output as JSON |
| `--include-prerelease` | Consider pre-release versions as "latest" |

Note: No `--check` flag needed (the feature is check-only by default). Kept for consistency with `/update-mcp-servers`.

### Text Output

```
Checking extensions across 2 tools...

  cursor-extensions
    [UPDATED]   ms-python.vscode-pylance   2024.8.1 -> 2026.1.101
    [CURRENT]   geddski.macros   1.2.1
    [CURRENT]   drcika.apc-extension   0.4.1
    ...

  windsurf-extensions
    [CURRENT]   ms-azuretools.vscode-docker   2.0.0
    ...

========== SUMMARY ==========
  Updated: 1  |  Current: 15  |  Skipped: 0  |  Failed: 0
```

### JSON Output

```json
{
  "tools": {
    "cursor-extensions": {
      "status": "ok",
      "configPath": "/Users/you/.cursor/extensions/extensions.json",
      "skippedNonGallery": 2,
      "servers": [
        {
          "key": "ms-python.vscode-pylance",
          "package": "ms-python.vscode-pylance",
          "current": "2024.8.1",
          "latest": "2026.1.101",
          "status": "updated"
        }
      ]
    }
  },
  "summary": { "updated": 1, "current": 15, "skipped": 0, "failed": 0 }
}
```

## Error Handling

### Marketplace API failures
- **Timeout** (10s default) → mark all extensions for that tool as `check_failed`, continue to next tool
- **429 rate limit** → abort remaining API calls, report partial results with warning
- **Extension not found** → mark as `not_found`, continue (may be unpublished, renamed, or private)
- **Network error** → mark as `check_failed`, continue
- **Empty/malformed extensions.json** → skip tool with warning, no `check_failed` count

### Large extension lists
- The Marketplace API `pageSize` max is 1000 (configurable)
- If a tool has > 1000 gallery extensions, split into batches of 1000 and merge results
- Realistically, most users have <50 extensions, so this is unlikely to trigger

### Non-gallery sources
- Extensions with `source: "vsix"` or `source: "undefined"` are excluded from the `servers` array and not queried against the Marketplace API
- Their count is tracked in `skippedNonGallery` on the tool result for informational purposes (not a failure, not counted in summary)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All checks successful, no outdated extensions found (or some are outdated with no failures) |
| 1 | Partial failure (some extensions failed to check) |
| 2 | Total error (bad args, no tools found, `--tool NAME` not found) |

## Dependencies

Zero new runtime dependencies. Uses Node.js >= 18.0.0 built-ins only.

## Slash Command

New file `commands/update-extensions.md`:

```markdown
---
description: Check for extension updates across Cursor and Windsurf
argument-hint: [--tool NAME] [--json] [--include-prerelease]
allowed-tools: Bash
---

Check extension versions against the VS Code Marketplace API for Cursor and Windsurf extensions.

```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts-mcp/update-extensions.js" 2>/dev/null | head -1 | xargs -I{} node {} $ARGUMENTS
```

Present the summary output to the user. If any extensions are outdated, note that the editors have no CLI for auto-installation — updates must be applied manually through the editor's extension panel.
```
