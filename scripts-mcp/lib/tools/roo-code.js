const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json',
    ),
    path.join(
      process.env.XDG_CONFIG_HOME
        ? path.isAbsolute(process.env.XDG_CONFIG_HOME)
          ? process.env.XDG_CONFIG_HOME
          : path.join(home, process.env.XDG_CONFIG_HOME)
        : path.join(home, '.config'),
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json',
    ),
  ];

  if (appData) {
    candidates.push(
      path.join(
        appData,
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json',
      ),
    );
  }

  return candidates;
}

// -------------------------------------------------------
// Extra fields that Roo Code uses beyond the basic MCP server config.
// These must be preserved during round-trip parse/write.
// -------------------------------------------------------

const EXTRA_FIELDS = ['timeout', 'type', 'disabled', 'alwaysAllow'];

// -------------------------------------------------------
// discover()
// -------------------------------------------------------

/**
 * Discovers the Roo Code MCP config file.
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

// -------------------------------------------------------
// parseMcpServers(configPath, rawJson)
// -------------------------------------------------------

/**
 * Parses MCP server entries from a Roo Code config object, including all extra fields.
 *
 * @param {string} _configPath - Config file path (unused directly; rawJson is already parsed).
 * @param {object} rawJson - The parsed JSON content of the Roo Code config file.
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

    // Include all Roo Code extra fields if present
    for (const field of EXTRA_FIELDS) {
      if (field in serverConfig) {
        entry[field] = serverConfig[field];
      }
    }

    result.push(entry);
  }

  return result;
}

// -------------------------------------------------------
// writeMcpServers(servers)
// -------------------------------------------------------

/**
 * Returns the MCP server configuration data for the caller to write.
 * Wraps an array of server entries into the Roo Code MCP config schema.
 * Receives the COMPLETE array (both updated and unchanged entries).
 * Extra fields from parseMcpServers() are preserved in output.
 * Note: Unlike cline.js, this function does NOT write to disk — it returns
 * the data object for the caller (update-mcp.js) to write via config-io.
 *
 * @param {Array} servers - Complete array of server entries (output of parseMcpServers).
 * @returns {{ mcpServers: { [key: string]: object } }}
 */
function writeMcpServers(servers) {
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

  return { mcpServers };
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

module.exports = {
  name: 'roo-code',
  discover,
  getCandidateConfigPaths,
  parseMcpServers,
  writeMcpServers,
};
