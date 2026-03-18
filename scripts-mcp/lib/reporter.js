// ---------------------------------------------------------------------------
// Status label helpers
// ---------------------------------------------------------------------------

const _STATUS_LABELS = {
  updated: 'UPDATED',
  current: 'CURRENT',
  skipped_non_npx: 'SKIPPED',
  skipped_floating: 'SKIPPED',
  check_failed: 'FAILED',
  not_found: 'SKIPPED',
  not_npm: 'SKIPPED',
};

function _labelForStatus(status) {
  return _STATUS_LABELS[status] || status.toUpperCase();
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

function formatText(data, toolCount) {
  const lines = [];
  lines.push(`Checking MCP servers across ${toolCount}${toolCount === 1 ? ' tool' : ' tools'}...`);
  lines.push('');

  const toolNames = Object.keys(data.tools);
  toolNames.forEach((toolName) => {
    const tool = data.tools[toolName];
    lines.push(`  ${toolName}`);

    tool.servers.forEach((server) => {
      const label = _labelForStatus(server.status);

      if (server.status === 'updated') {
        lines.push(`    [${label}]   ${server.package || server.key}   ${server.current} -> ${server.latest}`);
      } else if (server.status === 'current') {
        lines.push(`    [${label}]   ${server.package || server.key}`);
      } else if (server.status === 'skipped_non_npx') {
        lines.push(`    [${label}]   ${server.key} (not npx-based)`);
      } else if (server.status === 'skipped_floating') {
        lines.push(`    [${label}]   ${server.package || server.key} (floating version)`);
      } else if (server.status === 'check_failed') {
        lines.push(`    [${label}]   ${server.package || server.key} (${server.error || 'unknown error'})`);
      } else if (server.status === 'not_found') {
        lines.push(`    [${label}]   ${server.package || server.key} (not on npm)`);
      } else if (server.status === 'not_npm') {
        lines.push(`    [${label}]   ${server.key} (not an npm package)`);
      } else {
        lines.push(`    [${label}]   ${server.package || server.key}`);
      }
    });

    lines.push('');
  });

  lines.push('========== SUMMARY ==========');
  lines.push(
    `  Updated: ${data.summary.updated}  |  Current: ${data.summary.current}  |  Skipped: ${data.summary.skipped}  |  Failed: ${data.summary.failed}`,
  );

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

function formatJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

module.exports = {
  formatText: formatText,
  formatJson: formatJson,
};
