#!/usr/bin/env node
// =============================================================================
// update-extensions.js -- Entry point and CLI parser for extension update checks
//
// Discovers VS Code fork editors (Cursor, Windsurf), reads their extensions.json,
// queries the VS Code Marketplace API for latest versions, and reports which
// extensions are outdated.
//
// Usage: node update-extensions.js [--tool NAME] [--json] [--include-prerelease]
//
// Exit codes:
//   0 - All checks successful
//   1 - Partial failure (some extensions failed to check)
//   2 - Total error (bad args, no tools found, --tool NAME not found)
// =============================================================================

'use strict';

var registry = require('./lib/registry.js');
var configIo = require('./lib/config-io.js');
var marketplaceResolver = require('./lib/marketplace-resolver.js');
var reporter = require('./lib/reporter.js');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  var opts = {
    toolName: null,
    json: false,
    includePreRelease: false
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
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
        return { error: 'Unknown flag: ' + arg + '. Use --help for usage.' };
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Process a single tool
// ---------------------------------------------------------------------------

async function processTool(discoveredTool, opts) {
  var tool = discoveredTool.tool;
  var configPath = discoveredTool.configPath;
  var toolResult = {
    status: 'ok',
    configPath: configPath,
    servers: [],
    skippedNonGallery: 0
  };

  // -- Read config
  var readResult = configIo.readConfig(configPath);
  if (!readResult.ok) {
    toolResult.status = 'parse_error';
    toolResult.error = readResult.error;
    return toolResult;
  }

  var rawJson = readResult.data;

  // -- Parse extensions
  var parsed;
  try {
    parsed = tool.parseExtensions(configPath, rawJson);
  } catch (e) {
    toolResult.status = 'parse_error';
    toolResult.error = 'failed to parse extensions: ' + e.message;
    return toolResult;
  }

  var extensions = parsed.extensions || [];
  toolResult.skippedNonGallery = parsed.skippedNonGallery || 0;

  // -- Nothing to check
  if (extensions.length === 0) {
    return toolResult;
  }

  // -- Query Marketplace API (batch)
  var ids = extensions.map(function (ext) { return ext.id; });
  var resolveResult = await marketplaceResolver.resolveLatest(ids, {
    includePreRelease: opts.includePreRelease
  });

  if (resolveResult.status !== 'ok') {
    // API failure -- mark all extensions as check_failed
    toolResult.status = 'api_error';
    toolResult.apiError = resolveResult.error;
    for (var i = 0; i < extensions.length; i++) {
      toolResult.servers.push({
        key: extensions[i].id,
        package: extensions[i].id,
        current: extensions[i].version,
        status: 'check_failed',
        error: resolveResult.error
      });
    }
    return toolResult;
  }

  // -- Compare installed vs latest
  var versions = resolveResult.versions || {};
  var notFound = resolveResult.notFound || [];

  for (var j = 0; j < extensions.length; j++) {
    var ext = extensions[j];
    var serverResult = {
      key: ext.id,
      package: ext.id,
      current: ext.version
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
  var parsed = parseArgs(argv);

  if (parsed.help) {
    console.log([
      '',
      'update-extensions.js -- Check extension updates for Cursor and Windsurf',
      '',
      'Usage: node update-extensions.js [flags]',
      '  --tool NAME           Only process named tool',
      '  --json                Output as JSON',
      '  --include-prerelease  Consider pre-release versions',
      '  --help                Show this help message',
      ''
    ].join('\n'));
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }

  // -- Discover ALL tools via registry, then filter to extension tools only
  var allDiscovered = registry.discover();
  var extensionTools = allDiscovered.filter(function (t) {
    return typeof t.tool.parseExtensions === 'function';
  });

  // -- Validate --tool NAME against extension tools
  if (parsed.toolName) {
    var found = extensionTools.some(function (t) { return t.name === parsed.toolName; });
    if (!found) {
      console.error("Tool '" + parsed.toolName + "' not found.");
      var names = extensionTools.map(function (t) { return t.name; });
      if (names.length > 0) {
        console.error('Available extension tools: ' + names.join(', '));
      }
      process.exit(2);
    }
  }

  // -- Filter to requested tool
  if (parsed.toolName) {
    extensionTools = extensionTools.filter(function (t) { return t.name === parsed.toolName; });
  }

  if (extensionTools.length === 0) {
    if (parsed.toolName) {
      console.error("Tool '" + parsed.toolName + "' is known but its config file was not found.");
    } else {
      console.error('No extension config files found for any supported tools.');
      console.error('Supported extension tools: cursor-extensions, windsurf-extensions');
    }
    process.exit(2);
  }

  // -- Process each tool
  var results = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  var hasFailures = false;

  for (var i = 0; i < extensionTools.length; i++) {
    var toolName = extensionTools[i].name;
    var toolResult = await processTool(extensionTools[i], parsed);
    results.tools[toolName] = toolResult;

    toolResult.servers.forEach(function (s) {
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
  main(process.argv.slice(2)).catch(function (err) {
    console.error('Fatal error:', err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs: parseArgs, main: main, processTool: processTool };
