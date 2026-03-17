---
description: Bulk-update MCP servers across Cursor, Cline, and Roo Code
argument-hint: [--dry-run] [--check] [--tool NAME] [--json] [--force]
allowed-tools: Bash
---

Run the MCP update script to check and update MCP server versions across AI coding tools. The script discovers MCP configs for installed tools and updates pinned npm versions.

Find the script in the plugin cache and execute it with any user-provided arguments. The script is located somewhere under `~/.claude/plugins/cache/` -- use `find` to locate it if needed. Do NOT hardcode the cache path; discover it dynamically.

```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts-mcp/update-mcp.js" 2>/dev/null | head -1 | xargs -I{} node {} $ARGUMENTS
```

After the script completes, present the summary output to the user. If any MCP servers were updated, remind the user to restart the relevant AI coding tool to pick up changes.
