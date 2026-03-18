const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Load all tool modules from tools/ directory
// ---------------------------------------------------------------------------

function _loadToolModules() {
  const toolsDir = path.join(__dirname, 'tools');
  const files = fs.readdirSync(toolsDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

  return files.map((f) => require(path.join(toolsDir, f)));
}

// ---------------------------------------------------------------------------
// Discover installed tools
// ---------------------------------------------------------------------------

function discover() {
  const modules = _loadToolModules();
  const found = [];

  modules.forEach((mod) => {
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
  return modules.map((mod) => mod.name);
}

module.exports = {
  discover: discover,
  getTool: getTool,
  listToolNames: listToolNames,
};
