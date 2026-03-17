'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'roo-code-test-'));

function tmpFile(name) {
  return path.join(TMPDIR, name);
}

function writeRaw(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function readRaw(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function cleanup() {
  for (const file of fs.readdirSync(TMPDIR)) {
    try { fs.unlinkSync(path.join(TMPDIR, file)); } catch (_) { /* best effort */ }
  }
}

const EXPECTED_CONFIG_PATH = path.join(
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
// discover() tests
// -------------------------------------------------------

describe('roo-code discover()', () => {
  it('returns configPath when file exists', () => {
    // Ensure the directory and file exist at the real Roo Code path
    fs.mkdirSync(path.dirname(EXPECTED_CONFIG_PATH), { recursive: true });
    writeRaw(EXPECTED_CONFIG_PATH, JSON.stringify({ mcpServers: {} }, null, 2));

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.discover();

    assert.equal(result, EXPECTED_CONFIG_PATH);

    // Cleanup
    try { fs.unlinkSync(EXPECTED_CONFIG_PATH); } catch (_) { /* best effort */ }
    try { fs.rmdirSync(path.dirname(EXPECTED_CONFIG_PATH)); } catch (_) { /* best effort */ }
    try { fs.rmdirSync(path.dirname(path.dirname(EXPECTED_CONFIG_PATH))); } catch (_) { /* best effort */ }
  });

  it('returns null when file does not exist', () => {
    let renamed = false;
    if (fs.existsSync(EXPECTED_CONFIG_PATH)) {
      const bakPath = EXPECTED_CONFIG_PATH + '.testbak';
      fs.renameSync(EXPECTED_CONFIG_PATH, bakPath);
      renamed = true;
    }

    try {
      delete require.cache[require.resolve('./roo-code.js')];
      const rooCode = require('./roo-code.js');
      const result = rooCode.discover();

      assert.equal(result, null);
    } finally {
      if (renamed) {
        const bakPath = EXPECTED_CONFIG_PATH + '.testbak';
        try { fs.renameSync(bakPath, EXPECTED_CONFIG_PATH); } catch (_) { /* best effort */ }
      }
    }
  });
});

// -------------------------------------------------------
// parseMcpServers() tests
// -------------------------------------------------------

describe('roo-code parseMcpServers()', () => {
  it('extracts all fields including extras (timeout, type, disabled, alwaysAllow)', () => {
    const rawJson = {
      mcpServers: {
        anthropic: {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server@1.2.3'],
          env: { API_KEY: 'test' },
          timeout: 60,
          type: 'stdio',
          disabled: false,
          alwaysAllow: ['tool1', 'tool2'],
        },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 1);
    const entry = result[0];
    assert.equal(entry.key, 'anthropic');
    assert.equal(entry.command, 'npx');
    assert.deepStrictEqual(entry.args, ['-y', '@anthropic/mcp-server@1.2.3']);
    assert.deepStrictEqual(entry.env, { API_KEY: 'test' });
    assert.equal(entry.timeout, 60);
    assert.equal(entry.type, 'stdio');
    assert.equal(entry.disabled, false);
    assert.deepStrictEqual(entry.alwaysAllow, ['tool1', 'tool2']);
  });

  it('handles servers missing some extra fields (does not crash)', () => {
    const rawJson = {
      mcpServers: {
        minimal: {
          command: 'node',
          args: ['server.js'],
        },
        partial: {
          command: 'npx',
          args: ['-y', 'some-pkg'],
          timeout: 30,
          disabled: true,
        },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 2);

    // Minimal server: extra fields should be undefined
    const minimal = result.find((s) => s.key === 'minimal');
    assert.equal(minimal.command, 'node');
    assert.deepStrictEqual(minimal.args, ['server.js']);
    assert.equal(minimal.timeout, undefined);
    assert.equal(minimal.type, undefined);
    assert.equal(minimal.disabled, undefined);
    assert.equal(minimal.alwaysAllow, undefined);
    assert.equal(minimal.env, undefined);

    // Partial server: only specified extras present
    const partial = result.find((s) => s.key === 'partial');
    assert.equal(partial.command, 'npx');
    assert.equal(partial.timeout, 30);
    assert.equal(partial.disabled, true);
    assert.equal(partial.type, undefined);
    assert.equal(partial.alwaysAllow, undefined);
  });

  it('handles empty mcpServers object', () => {
    const rawJson = { mcpServers: {} };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 0);
    assert.ok(Array.isArray(result));
  });

  it('returns empty array for missing mcpServers key', () => {
    const rawJson = {};

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 0);
  });

  it('returns empty array for null mcpServers', () => {
    const rawJson = { mcpServers: null };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 0);
  });

  it('returns empty array for non-object rawJson', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', null);

    assert.equal(result.length, 0);
  });

  it('skips non-object server entries', () => {
    const rawJson = {
      mcpServers: {
        valid: { command: 'echo' },
        invalid: 'not-an-object',
        alsoValid: { command: 'node', args: [] },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 2);
    assert.equal(result[0].key, 'valid');
    assert.equal(result[1].key, 'alsoValid');
  });

  it('handles multiple server entries', () => {
    const rawJson = {
      mcpServers: {
        server1: { command: 'npx', args: ['-y', 'pkg1@1.0.0'], env: {}, timeout: 60, type: 'stdio', disabled: false, alwaysAllow: ['a'] },
        server2: { command: 'node', args: ['index.js'], env: { PORT: '3000' }, timeout: 30, type: 'sse', disabled: true, alwaysAllow: [] },
        server3: { command: 'python', args: ['-m', 'server'], env: {}, timeout: null, type: 'stdio', disabled: false, alwaysAllow: ['b', 'c'] },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const result = rooCode.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 3);
    assert.equal(result[0].key, 'server1');
    assert.equal(result[1].key, 'server2');
    assert.equal(result[2].key, 'server3');
  });
});

// -------------------------------------------------------
// writeMcpServers() tests
// -------------------------------------------------------

describe('roo-code writeMcpServers()', () => {
  it('wraps in Roo Code schema preserving all extra fields', () => {
    const p = tmpFile('roo-write-full.json');
    const servers = [
      {
        key: 'anthropic',
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server@1.2.3'],
        env: { API_KEY: 'test' },
        timeout: 60,
        type: 'stdio',
        disabled: false,
        alwaysAllow: ['tool1', 'tool2'],
      },
    ];

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const configObj = rooCode.writeMcpServers(servers);

    // writeMcpServers returns a plain object (not written to disk)
    assert.ok(configObj.mcpServers, 'should have mcpServers key');
    assert.ok(configObj.mcpServers.anthropic, 'should have server entry');

    const server = configObj.mcpServers.anthropic;
    assert.equal(server.command, 'npx');
    assert.deepStrictEqual(server.args, ['-y', '@anthropic/mcp-server@1.2.3']);
    assert.deepStrictEqual(server.env, { API_KEY: 'test' });
    assert.equal(server.timeout, 60);
    assert.equal(server.type, 'stdio');
    assert.equal(server.disabled, false);
    assert.deepStrictEqual(server.alwaysAllow, ['tool1', 'tool2']);

    // Write to disk via config-io to verify it serializes correctly
    const { writeConfig } = require('../config-io.js');
    const writeResult = writeConfig(p, configObj);
    assert.equal(writeResult.ok, true);

    const written = JSON.parse(readRaw(p));
    assert.deepStrictEqual(written, configObj);
  });

  it('writes only defined extra fields (no undefined pollution)', () => {
    const p = tmpFile('roo-write-minimal.json');
    const servers = [
      {
        key: 'minimal',
        command: 'node',
        args: ['server.js'],
      },
    ];

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const configObj = rooCode.writeMcpServers(servers);

    assert.ok(configObj.mcpServers);
    const server = configObj.mcpServers.minimal;

    assert.equal(server.command, 'node');
    assert.deepStrictEqual(server.args, ['server.js']);
    // Extra fields should NOT be present
    assert.equal('timeout' in server, false, 'timeout should not be in output');
    assert.equal('type' in server, false, 'type should not be in output');
    assert.equal('disabled' in server, false, 'disabled should not be in output');
    assert.equal('alwaysAllow' in server, false, 'alwaysAllow should not be in output');
    assert.equal('env' in server, false, 'env should not be in output');
  });

  it('writes multiple servers', () => {
    const p = tmpFile('roo-write-multi.json');
    const servers = [
      {
        key: 'server-a',
        command: 'npx',
        args: ['-y', 'pkg-a@1.0.0'],
        timeout: 30,
        type: 'stdio',
        disabled: true,
        alwaysAllow: [],
      },
      {
        key: 'server-b',
        command: 'node',
        args: ['server.js'],
        timeout: 120,
      },
    ];

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const configObj = rooCode.writeMcpServers(servers);

    assert.ok(configObj.mcpServers['server-a']);
    assert.ok(configObj.mcpServers['server-b']);

    assert.equal(configObj.mcpServers['server-a'].timeout, 30);
    assert.equal(configObj.mcpServers['server-a'].disabled, true);
    assert.deepStrictEqual(configObj.mcpServers['server-a'].alwaysAllow, []);

    assert.equal(configObj.mcpServers['server-b'].timeout, 120);
    assert.equal('disabled' in configObj.mcpServers['server-b'], false);
  });

  it('handles an empty servers array', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');
    const configObj = rooCode.writeMcpServers([]);

    assert.deepStrictEqual(configObj, { mcpServers: {} });
  });
});

// -------------------------------------------------------
// Round-trip test
// -------------------------------------------------------

describe('roo-code round-trip', () => {
  it('parse -> pass through -> write preserves all extra fields', () => {
    const p = tmpFile('roo-roundtrip.json');

    const originalConfig = {
      mcpServers: {
        'full-server': {
          command: 'npx',
          args: ['-y', '@anthropic/mcp-server@1.2.3'],
          env: { ANTHROPIC_API_KEY: 'sk-test' },
          timeout: 60,
          type: 'stdio',
          disabled: false,
          alwaysAllow: ['tool1', 'tool2'],
        },
        'partial-server': {
          command: 'node',
          args: ['server.js'],
          timeout: 30,
          disabled: true,
        },
        'minimal-server': {
          command: 'npx',
          args: ['-y', 'minimal-pkg'],
        },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    // Parse
    const parsed = rooCode.parseMcpServers(p, originalConfig);

    // Write back (returns object, not written to disk)
    const configObj = rooCode.writeMcpServers(parsed);

    // Verify the object matches original
    const originalServers = originalConfig.mcpServers;
    const roundTrippedServers = configObj.mcpServers;

    // Full server: all fields preserved
    assert.deepStrictEqual(
      roundTrippedServers['full-server'],
      originalServers['full-server'],
      'full-server should have identical round-trip'
    );

    // Partial server: all present fields preserved, absent fields stay absent
    assert.deepStrictEqual(
      roundTrippedServers['partial-server'],
      originalServers['partial-server'],
      'partial-server should have identical round-trip'
    );

    // Minimal server: only basic fields preserved
    assert.deepStrictEqual(
      roundTrippedServers['minimal-server'],
      originalServers['minimal-server'],
      'minimal-server should have identical round-trip'
    );

    // Also verify it serializes and reads back correctly via config-io
    const { writeConfig, readConfig } = require('../config-io.js');
    const writeResult = writeConfig(p, configObj);
    assert.equal(writeResult.ok, true);

    const readResult = readConfig(p);
    assert.equal(readResult.ok, true);
    assert.deepStrictEqual(readResult.data, configObj);
  });

  it('preserves env object entries through round-trip', () => {
    const p = tmpFile('roo-roundtrip-env.json');

    const originalConfig = {
      mcpServers: {
        server1: {
          command: 'npx',
          args: ['-y', 'pkg@1.0.0'],
          env: {
            KEY1: 'value1',
            KEY2: 'value2',
            KEY3: 'value with spaces',
          },
          timeout: 90,
          type: 'stdio',
          disabled: false,
          alwaysAllow: [],
        },
      },
    };

    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    const parsed = rooCode.parseMcpServers(p, originalConfig);
    assert.deepStrictEqual(parsed[0].env, {
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value with spaces',
    });

    const configObj = rooCode.writeMcpServers(parsed);
    assert.deepStrictEqual(configObj.mcpServers.server1.env, {
      KEY1: 'value1',
      KEY2: 'value2',
      KEY3: 'value with spaces',
    });
  });
});

// -------------------------------------------------------
// Module exports
// -------------------------------------------------------

describe('module exports', () => {
  it('exports name as "roo-code"', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const mod = require('./roo-code.js');
    assert.equal(mod.name, 'roo-code');
  });

  it('exports discover as a function', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const mod = require('./roo-code.js');
    assert.equal(typeof mod.discover, 'function');
  });

  it('exports parseMcpServers as a function', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const mod = require('./roo-code.js');
    assert.equal(typeof mod.parseMcpServers, 'function');
  });

  it('exports writeMcpServers as a function', () => {
    delete require.cache[require.resolve('./roo-code.js')];
    const mod = require('./roo-code.js');
    assert.equal(typeof mod.writeMcpServers, 'function');
  });
});
