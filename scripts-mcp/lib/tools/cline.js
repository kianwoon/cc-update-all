const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { writeConfig } = require('../config-io');

function getCandidateConfigPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA;

  const candidates = [
    path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
    path.join(
      process.env.XDG_CONFIG_HOME
        ? (path.isAbsolute(process.env.XDG_CONFIG_HOME)
            ? process.env.XDG_CONFIG_HOME
            : path.join(home, process.env.XDG_CONFIG_HOME))
        : path.join(home, '.config'),
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
  ];

  if (appData) {
    candidates.push(
      path.join(
        appData,
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
    );
  }

  return candidates;
}

/**
 * Discovers the Cline MCP config file.
 *
 * @returns {string | null} Absolute config path if the file exists, otherwise null.
 */
function discover() {
  const candidates = getCandidateConfigPaths();
  for (const configPath of candidates) {
    try {
      fs.accessSync(configPath, fs.constants.R_OK);
      return configPath;
    } catch (_) {
      // Try next candidate.
    }
  }

  return null;
}

/**
 * Extra fields that Cline uses beyond the basic MCP server config.
 * These must be preserved during round-trip parse/write.
 */
const EXTRA_FIELDS = ['timeout', 'type', 'disabled', 'alwaysAllow'];

/**
 * Parses MCP server entries from a Cline config object, including all extra fields.
 *
 * @param {string} _configPath - Config file path (unused directly; rawJson is already parsed).
 * @param {object} rawJson - The parsed JSON content of the Cline config file.
 * @returns {Array<{ key: string, command: string, args: string[], env?: object, timeout?: number, type?: string, disabled?: boolean, alwaysAllow?: string[] }>}
 */
function parseMcpServers(_configPath, rawJson) {
  const mcpServers = rawJson?.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return [];
  }

  const result = [];
  for (const [key, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig || typeof serverConfig !== 'object') {
      continue;
    }

    const entry = {
      key,
      command: serverConfig.command,
      args: serverConfig.args,
    };

    // Include env if present
    if ('env' in serverConfig) {
      entry.env = serverConfig.env;
    }

    // Include all Cline extra fields if present
    for (const field of EXTRA_FIELDS) {
      if (field in serverConfig) {
        entry[field] = serverConfig[field];
      }
    }

    result.push(entry);
  }

  return result;
}

/**
 * Writes a complete array of MCP server entries to the Cline config file,
 * wrapping them in the Cline schema and preserving all extra fields.
 *
 * @param {Array} servers - Complete array of server entries (output of parseMcpServers).
 * @param {string} [configPath] - Config file path. Defaults to the discovered Cline path.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function writeMcpServers(servers, configPath) {
  const targetPath = configPath || discover();

  const mcpServers = {};
  for (const server of servers) {
    const { key, ...rest } = server;
    mcpServers[key] = {};

    // Always include core fields
    mcpServers[key].command = rest.command;
    mcpServers[key].args = rest.args;

    // Include env if defined
    if (rest.env !== undefined) {
      mcpServers[key].env = rest.env;
    }

    // Include extra fields only if defined (no undefined pollution)
    for (const field of EXTRA_FIELDS) {
      if (rest[field] !== undefined) {
        mcpServers[key][field] = rest[field];
      }
    }
  }

  return writeConfig(targetPath, { mcpServers });
}

module.exports = {
  name: 'cline',
  discover,
  getCandidateConfigPaths,
  parseMcpServers,
  writeMcpServers,
};
