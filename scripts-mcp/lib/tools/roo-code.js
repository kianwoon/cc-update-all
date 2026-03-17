'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CONFIG_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Code',
  'User',
  'globalStorage',
  'rooveterinaryinc.roo-cline',
  'settings',
  'mcp_settings.json'
);

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
  try {
    fs.accessSync(CONFIG_PATH, fs.constants.R_OK);
    return CONFIG_PATH;
  } catch (_) {
    return null;
  }
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
  const mcpServers = rawJson && rawJson.mcpServers;
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
 * Wraps an array of server entries into the Roo Code MCP config schema.
 * Receives the COMPLETE array (both updated and unchanged entries).
 * Extra fields from parseMcpServers() are preserved in output.
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
  parseMcpServers,
  writeMcpServers,
};
