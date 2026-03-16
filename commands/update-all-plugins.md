---
description: Update all installed plugin marketplaces
argument-hint: [--dry-run] [--check] [--only NAME] [--json] [--force]
allowed-tools: Bash
---

Run the cc-update-all script to update all installed plugin marketplaces. The script discovers which marketplaces have installed plugins and only updates those.

Find the script in the plugin cache and execute it with any user-provided arguments. The script is located somewhere under `~/.claude/plugins/cache/` — use `find` to locate it if needed. Do NOT hardcode the cache path; discover it dynamically.

```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts/cc-update-all.sh" 2>/dev/null | head -1 | xargs -I{} bash {} $ARGUMENTS
```

After the script completes, present the summary output to the user in a clean format. If the output contains a summary table, display it as-is. If the output is JSON (when --json flag is used), format it as a readable summary table instead.

If any marketplaces failed to update, highlight the failures and suggest remediation steps. Always remind the user to restart Claude Code to pick up plugin changes.
