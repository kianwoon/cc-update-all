'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readConfig, writeConfig } = require('../config-io');

// -------------------------------------------------------
// Config path
// -------------------------------------------------------

/**
 * Returns the full path to the Roo Code MCP settings file.
 * Config: ~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json
 */
function getConfigPath() {
  return path.join(
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
}

// -------------------------------------------------------
// discover()
// -------------------------------------------------------

/**
 * Checks whether the Roo Code MCP config file exists.
 *
 * @returns {string | null} The config path if the file exists, otherwise null.
 */
function discover() {
  const configPath = getConfigPath();
  return fs.existsSync(configPath) ? configPath : null;
}

// -------------------------------------------------------
// parseMcpServers(configPath, rawJson)
// -------------------------------------------------------

/**
 * Parses the mcpServers object from Roo Code's config JSON.
 * Returns an array of { key, command, args, env, timeout, type, disabled, alwaysAllow }
 * entries. Unknown server fields are preserved via spread so round-trips don't lose data.
 *
 * @param {string} configPath - Path to the config file (used for error messages).
 * @param {object} rawJson   - The parsed JSON object (the entire file content).
 * @returns {Array<{ key: string, command: string, args: string[], env: object,
 *                    timeout: number, type: string, disabled: boolean,
 *                    alwaysAllow: string[], _raw?: object }>}
 */
function parseMcpServers(configPath, rawJson) {
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error(`invalid config (not an object): ${configPath}`);
  }

  const mcpServers = rawJson.mcpServers;
  if (!mcpServers || typeof mcpServers !== 'object') {
    return [];
  }

  const servers = [];
  for (const [key, server] of Object.entries(mcpServers)) {
    if (!server || typeof server !== 'object') {
      continue;
    }
    const entry = {
      key,
      command: server.command || '',
      args: Array.isArray(server.args) ? server.args : [],
      env: server.env && typeof server.env === 'object' ? { ...server.env } : {},
      timeout: server.timeout != null ? server.timeout : null,
      type: server.type || 'stdio',
      disabled: server.disabled === true,
      alwaysAllow: Array.isArray(server.alwaysAllow) ? [...server.alwaysAllow] : [],
    };
    Object.defineProperty(entry, '_raw', { value: server, enumerable: false });
    servers.push(entry);
  }

  return servers;
}

// -------------------------------------------------------
// writeMcpServers(servers)
// -------------------------------------------------------

/**
 * Wraps an array of parsed server entries back into Roo Code's config schema
 * and writes it to the config file.
 *
 * @param {Array<{ key: string, command: string, args: string[], env: object,
 *                  timeout: number, type: string, disabled: boolean,
 *                  alwaysAllow: string[], _raw?: object }>} servers
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function writeMcpServers(servers) {
  const mcpServers = {};
  for (const entry of servers) {
    const { key, _raw, ...knownFields } = entry;
    if (_raw) {
      mcpServers[key] = { ..._raw, ...knownFields };
    } else {
      mcpServers[key] = knownFields;
    }
  }

  const config = { mcpServers };
  const configPath = module.exports.getConfigPath();
  return writeConfig(configPath, config);
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

module.exports = {
  name: 'roo-code',
  discover,
  parseMcpServers,
  writeMcpServers,
  getConfigPath, // exported for testing
};
