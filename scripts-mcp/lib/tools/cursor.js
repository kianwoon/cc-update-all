const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readConfig } = require('../config-io');

/**
 * Returns the path to the Cursor MCP config file if it exists, otherwise null.
 *
 * @returns {string | null}
 */
function discover() {
  const configPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  return fs.existsSync(configPath) ? configPath : null;
}

/**
 * Parses MCP server entries from a Cursor config object.
 *
 * @param {string} configPath - Path to the config file (unused internally, kept for interface consistency).
 * @param {object} rawJson - The parsed JSON content of the config file.
 * @returns {Array<{ key: string, command: string, args: string[], env?: object }>}
 */
function parseMcpServers(configPath, rawJson) {
  const servers =
    rawJson?.mcpServers && typeof rawJson.mcpServers === 'object' && !Array.isArray(rawJson.mcpServers)
      ? rawJson.mcpServers
      : {};
  return Object.entries(servers).map(([key, entry]) => ({
    key,
    ...entry,
  }));
}

/**
 * Wraps an array of server entries into the Cursor MCP config schema.
 * Receives the COMPLETE array (both updated and unchanged entries).
 *
 * @param {Array<{ key: string, command: string, args: string[], env?: object }>} servers
 * @returns {{ mcpServers: { [key: string]: object } }}
 */
function writeMcpServers(servers) {
  const mcpServers = {};
  for (const server of servers) {
    const { key, ...rest } = server;
    mcpServers[key] = rest;
  }
  return { mcpServers };
}

module.exports = { name: 'cursor', discover, parseMcpServers, writeMcpServers };
