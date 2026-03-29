const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Module cache — loaded once, reused across discover/getTool/listToolNames
// ---------------------------------------------------------------------------
let _cachedModules = null;

function _loadToolModules() {
  if (_cachedModules !== null) {
    return _cachedModules;
  }

  const toolsDir = path.join(__dirname, 'tools');
  const files = fs.readdirSync(toolsDir).filter(function(f) { return f.endsWith('.js') && !f.endsWith('.test.js'); });

  _cachedModules = files.map(function(f) {
    const filePath = path.join(toolsDir, f);
    try {
      return require(filePath);
    } catch (err) {
      console.error('Warning: failed to load tool module ' + f + ': ' + err.message);
      return null;
    }
  }).filter(Boolean);

  return _cachedModules;
}

// ---------------------------------------------------------------------------
// Discover installed tools
// ---------------------------------------------------------------------------

function discover() {
  const modules = _loadToolModules();
  const found = [];

  modules.forEach(function(mod) {
    const configPath = mod.discover();
    if (configPath) {
      found.push({
        name: mod.name,
        configPath: configPath,
        tool: mod,
      });
    }
  });

  return found;
}

// ---------------------------------------------------------------------------
// Get tool by name
// ---------------------------------------------------------------------------

function getTool(name) {
  const modules = _loadToolModules();
  for (let i = 0; i < modules.length; i++) {
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
  const modules = _loadToolModules();
  return modules.map(function(mod) { return mod.name; });
}

module.exports = {
  discover: discover,
  getTool: getTool,
  listToolNames: listToolNames,
};
