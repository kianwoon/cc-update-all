// =============================================================================
// registry.js -- Discovers and loads tool modules from the tools/ directory
//
// Each tool module exports:
//   { name, discover(), parseMcpServers(configPath, rawJson), writeMcpServers(servers) }
//
// registry.discover() calls discover() on each tool and returns only
// tools whose config files exist on disk.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load all tool modules from tools/ directory
// ---------------------------------------------------------------------------

function _loadToolModules() {
  var toolsDir = path.join(__dirname, 'tools');
  var files = fs.readdirSync(toolsDir).filter(function (f) {
    return f.endsWith('.js') && !f.endsWith('.test.js');
  });

  return files.map(function (f) {
    return require(path.join(toolsDir, f));
  });
}

// ---------------------------------------------------------------------------
// Discover installed tools
// ---------------------------------------------------------------------------

function discover() {
  var modules = _loadToolModules();
  var found = [];

  modules.forEach(function (mod) {
    var configPath = mod.discover();
    if (configPath) {
      found.push({
        name: mod.name,
        configPath: configPath,
        tool: mod
      });
    }
  });

  return found;
}

// ---------------------------------------------------------------------------
// Get tool by name
// ---------------------------------------------------------------------------

function getTool(name) {
  var modules = _loadToolModules();
  for (var i = 0; i < modules.length; i++) {
    if (modules[i].name === name) {
      return modules[i];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// List all available tool names
// ---------------------------------------------------------------------------

function listToolNames() {
  var modules = _loadToolModules();
  return modules.map(function (mod) { return mod.name; });
}

module.exports = {
  discover: discover,
  getTool: getTool,
  listToolNames: listToolNames
};
