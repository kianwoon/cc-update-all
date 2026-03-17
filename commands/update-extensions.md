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
