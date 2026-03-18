#!/usr/bin/env node

const registry = require('./lib/registry.js');
const configIo = require('./lib/config-io.js');
const marketplaceResolver = require('./lib/marketplace-resolver.js');
const reporter = require('./lib/reporter.js');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    toolName: null,
    json: false,
    includePreRelease: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
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
      case '--include-prerelease':
        opts.includePreRelease = true;
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
    skippedNonGallery: 0,
  };

  // -- Read config
  const readResult = configIo.readConfig(configPath);
  if (!readResult.ok) {
    toolResult.status = 'parse_error';
    toolResult.error = readResult.error;
    return toolResult;
  }

  const rawJson = readResult.data;

  // -- Parse extensions
  let parsed;
  try {
    parsed = tool.parseExtensions(configPath, rawJson);
  } catch (e) {
    toolResult.status = 'parse_error';
    toolResult.error = `failed to parse extensions: ${e.message}`;
    return toolResult;
  }

  const extensions = parsed.extensions || [];
  toolResult.skippedNonGallery = parsed.skippedNonGallery || 0;

  // -- Nothing to check
  if (extensions.length === 0) {
    return toolResult;
  }

  // -- Query Marketplace API (batch)
  const ids = extensions.map((ext) => ext.id);
  const resolveResult = await marketplaceResolver.resolveLatest(ids, {
    includePreRelease: opts.includePreRelease,
  });

  if (resolveResult.status !== 'ok') {
    // API failure -- mark all extensions as check_failed
    toolResult.status = 'api_error';
    toolResult.apiError = resolveResult.error;
    for (let i = 0; i < extensions.length; i++) {
      toolResult.servers.push({
        key: extensions[i].id,
        package: extensions[i].id,
        current: extensions[i].version,
        status: 'check_failed',
        error: resolveResult.error,
      });
    }
    return toolResult;
  }

  // -- Compare installed vs latest
  const versions = resolveResult.versions || {};
  const notFound = resolveResult.notFound || [];

  for (let j = 0; j < extensions.length; j++) {
    const ext = extensions[j];
    const serverResult = {
      key: ext.id,
      package: ext.id,
      current: ext.version,
    };

    if (notFound.indexOf(ext.id) !== -1) {
      serverResult.status = 'not_found';
    } else if (versions[ext.id]) {
      serverResult.latest = versions[ext.id];
      if (ext.version === versions[ext.id]) {
        serverResult.status = 'current';
      } else {
        serverResult.status = 'updated';
      }
    } else {
      // Not in notFound but also not in versions -- shouldn't happen,
      // but treat as not_found
      serverResult.status = 'not_found';
    }

    toolResult.servers.push(serverResult);
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
        'update-extensions.js -- Check extension updates for Cursor and Windsurf',
        '',
        'Usage: node update-extensions.js [flags]',
        '  --tool NAME           Only process named tool',
        '  --json                Output as JSON',
        '  --include-prerelease  Consider pre-release versions',
        '  --help                Show this help message',
        '',
      ].join('\n'),
    );
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }

  // -- Discover ALL tools via registry, then filter to extension tools only
  const allDiscovered = registry.discover();
  let extensionTools = allDiscovered.filter((t) => typeof t.tool.parseExtensions === 'function');

  // -- Validate --tool NAME against extension tools
  if (parsed.toolName) {
    const found = extensionTools.some((t) => t.name === parsed.toolName);
    if (!found) {
      console.error(`Tool '${parsed.toolName}' not found.`);
      const names = extensionTools.map((t) => t.name);
      if (names.length > 0) {
        console.error(`Available extension tools: ${names.join(', ')}`);
      }
      process.exit(2);
    }
  }

  // -- Filter to requested tool
  if (parsed.toolName) {
    extensionTools = extensionTools.filter((t) => t.name === parsed.toolName);
  }

  if (extensionTools.length === 0) {
    if (parsed.toolName) {
      console.error(`Tool '${parsed.toolName}' is known but its config file was not found.`);
    } else {
      console.error('No extension config files found for any supported tools.');
      console.error('Supported extension tools: cursor-extensions, windsurf-extensions');
    }
    process.exit(2);
  }

  // -- Process each tool
  const results = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  let hasFailures = false;

  for (let i = 0; i < extensionTools.length; i++) {
    const toolName = extensionTools[i].name;
    const toolResult = await processTool(extensionTools[i], parsed);
    results.tools[toolName] = toolResult;

    toolResult.servers.forEach((s) => {
      switch (s.status) {
        case 'updated':
          results.summary.updated++;
          break;
        case 'current':
          results.summary.current++;
          break;
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
    console.log(reporter.formatText(results, extensionTools.length));
  }

  // -- Exit code
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
