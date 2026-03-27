#!/usr/bin/env node

const registry = require('./lib/registry.js');
const configIo = require('./lib/config-io.js');
const npmResolver = require('./lib/npm-resolver.js');
const reporter = require('./lib/reporter.js');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    check: false,
    toolName: null,
    json: false,
    force: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--tool':
        i++;
        if (i >= argv.length || argv[i].startsWith('--')) {
          return { error: '--tool requires a tool name' };
        }
        opts.toolName = argv[i];
        break;
      case '--json':
        opts.json = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--help':
      case '-h':
        return { help: true };
      default:
        return { error: `Unknown flag: ${arg}. Use --help for usage.` };
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Process a single tool
// ---------------------------------------------------------------------------

async function processTool(discoveredTool, opts) {
  const tool = discoveredTool.tool;
  const configPath = discoveredTool.configPath;
  const toolResult = {
    status: 'ok',
    configPath: configPath,
    servers: [],
  };

  // -- Read config
  const readResult = configIo.readConfig(configPath);
  if (!readResult.ok) {
    toolResult.status = 'parse_error';
    toolResult.error = readResult.error;
    return toolResult;
  }

  const rawJson = readResult.data;

  // -- Parse MCP servers
  let servers;
  try {
    servers = tool.parseMcpServers(configPath, rawJson);
  } catch (e) {
    toolResult.status = 'parse_error';
    toolResult.error = `failed to parse MCP servers: ${e.message}`;
    return toolResult;
  }

  // -- Check each npx-based server
  let hasUpdates = false;
  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const serverResult = { key: server.key };

    if (server.command !== 'npx') {
      serverResult.status = 'skipped_non_npx';
      toolResult.servers.push(serverResult);
      continue;
    }

    // Extract package and pinned version
    const extracted = npmResolver.extractPinnedVersion(server.args);

    if (extracted.status === 'not_npm') {
      serverResult.status = 'not_npm';
      toolResult.servers.push(serverResult);
      continue;
    }

    if (extracted.status === 'skipped_floating') {
      serverResult.package = extracted.pkg;
      serverResult.status = 'skipped_floating';
      toolResult.servers.push(serverResult);
      continue;
    }

    // Has pinned version -- check npm for latest
    serverResult.package = extracted.pkg;
    serverResult.current = extracted.pinned;

    const resolveResult = await npmResolver.resolveLatest(extracted.pkg);

    if (resolveResult.status !== 'ok') {
      serverResult.status = resolveResult.status;
      if (resolveResult.error) serverResult.error = resolveResult.error;
      toolResult.servers.push(serverResult);
      continue;
    }

    serverResult.latest = resolveResult.latest;

    if (extracted.pinned === resolveResult.latest) {
      serverResult.status = 'current';
    } else {
      serverResult.status = 'updated';
      hasUpdates = true;

      // Mutate the server args to update the version
      for (let j = 0; j < server.args.length; j++) {
        const arg = server.args[j];
        // Match exact pkgArg or pkg@version pattern
        const pattern = `${extracted.pkg}@`;
        const atIdx = arg.indexOf(pattern);
        if (atIdx !== -1) {
          const prefix = arg.substring(0, atIdx + pattern.length);
          const oldVersion = arg.substring(atIdx + pattern.length);
          // Only replace if the version part matches what we extracted
          if (oldVersion === extracted.pinned) {
            const newArg = prefix + resolveResult.latest;
            if (newArg !== arg) {
              server.args[j] = newArg;
              hasUpdates = true;
              break;
            }
          }
        }
      }
    }

    toolResult.servers.push(serverResult);
  }

  // -- Write back if there are updates and not in check/dry-run mode
  if (hasUpdates && !opts.dryRun && !opts.check) {
    const writeData = tool.writeMcpServers(servers);
    const writeResult = configIo.writeConfig(configPath, writeData, { force: opts.force });
    if (!writeResult.ok) {
      toolResult.status = 'write_error';
      toolResult.writeError = writeResult.error;
    }
  }

  return toolResult;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const parsed = parseArgs(argv);

  if (parsed.help) {
    console.log(
      [
        '',
        'update-mcp.js -- Bulk-update MCP server versions',
        '',
        'Usage: node update-mcp.js [flags]',
        '  --dry-run       Show what would change without writing',
        '  --check         Report outdated only, exit 1 if any',
        '  --tool NAME     Only process named tool',
        '  --json          Output as JSON',
        '  --force         Skip mtime safety check',
        '  --help          Show this help message',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }

  // -- Validate --tool NAME
  if (parsed.toolName) {
    const toolModule = registry.getTool(parsed.toolName);
    if (!toolModule) {
      console.error(`Tool '${parsed.toolName}' not found.`);
      console.error(`Available tools: ${registry.listToolNames().join(', ')}`);
      process.exit(2);
    }
  }

  // -- Discover tools
  let discovered = registry.discover();

  if (parsed.toolName) {
    discovered = discovered.filter((t) => t.name === parsed.toolName);
  }

  if (discovered.length === 0) {
    if (parsed.toolName) {
      console.error(`Tool '${parsed.toolName}' is known but its config file was not found.`);
      console.error('The tool may not be installed or configured.');
    } else {
      console.error('No MCP config files found for any supported tools.');
      console.error(`Supported tools: ${registry.listToolNames().join(', ')}`);
    }
    process.exit(2);
  }

  // -- Process each tool
  const results = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  let hasOutdated = false;
  let hasFailures = false;

  for (let i = 0; i < discovered.length; i++) {
    const toolName = discovered[i].name;
    const toolResult = await processTool(discovered[i], parsed);
    results.tools[toolName] = toolResult;

    toolResult.servers.forEach((s) => {
      switch (s.status) {
        case 'updated':
          results.summary.updated++;
          hasOutdated = true;
          break;
        case 'current':
          results.summary.current++;
          break;
        case 'skipped_non_npx':
        case 'skipped_floating':
        case 'not_npm':
        case 'not_found':
          results.summary.skipped++;
          break;
        case 'check_failed':
          results.summary.failed++;
          hasFailures = true;
          break;
        default:
          results.summary.skipped++;
      }
    });

    if (toolResult.status !== 'ok') {
      hasFailures = true;
    }
  }

  // -- Output
  if (parsed.json) {
    console.log(reporter.formatJson(results));
  } else {
    console.log(reporter.formatText(results, discovered.length));
  }

  // -- Exit code
  if (parsed.check && hasOutdated) {
    process.exit(1);
  }

  if (hasFailures) {
    process.exit(1);
  }

  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs: parseArgs, main: main, processTool: processTool };
