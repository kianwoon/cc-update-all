---
description: Update all installed plugin marketplaces
argument-hint: [--dry-run] [--only NAME] [--json] [--force]
allowed-tools: Bash
---

Run the cc-update-all script to update all installed plugin marketplaces. The script discovers which marketplaces have installed plugins and only updates those.

Execute the script with any user-provided arguments. IMPORTANT: Use `$CLAUDE_PLUGIN_ROOT` exactly as written below — it is an environment variable set by Claude Code. Do NOT replace it with a hardcoded path.

```bash
bash "$CLAUDE_PLUGIN_ROOT/scripts/cc-update-all.sh" $ARGUMENTS
```

After the script completes, present the summary output to the user in a clean format. If the output contains a summary table, display it as-is. If the output is JSON (when --json flag is used), format it as a readable summary table instead.

If any marketplaces failed to update, highlight the failures and suggest remediation steps. Always remind the user to restart Claude Code to pick up plugin changes.
