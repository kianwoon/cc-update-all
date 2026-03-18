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

function tmpDir(name) {
  const dir = path.join(TMPDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRaw(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function readRaw(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function cleanup() {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
}

const realHomedir = os.homedir;
const realXdgConfigHome = process.env.XDG_CONFIG_HOME;
const realAppData = process.env.APPDATA;
let fakeHome = null;

function stubHomedir(home) {
  fakeHome = home;
  os.homedir = () => fakeHome;
}

function restoreEnv() {
  os.homedir = realHomedir;
  if (realXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = realXdgConfigHome;
  }

  if (realAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = realAppData;
  }
}

describe('roo-code', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
    cleanup();
  });
});

describe('roo-code discover()', () => {
  it('returns macOS configPath when file exists', () => {
    const home = tmpDir('home-macos');
    const configPath = path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json'
    );

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    assert.equal(rooCode.discover(), configPath);
  });

  it('returns Linux configPath when file exists in XDG config home', () => {
    const home = tmpDir('home-linux');
    const xdgConfigHome = path.join(home, '.config');
    const configPath = path.join(
      xdgConfigHome,
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json'
    );

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    assert.equal(rooCode.discover(), configPath);
  });

  it('returns Windows configPath when file exists in APPDATA', () => {
    const home = tmpDir('home-windows');
    const xdgConfigHome = path.join(home, '.config');
    const appData = path.join(home, 'AppData', 'Roaming');
    const configPath = path.join(
      appData,
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json'
    );

    fs.rmSync(xdgConfigHome, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.APPDATA = appData;
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    assert.equal(rooCode.discover(), configPath);
  });

  it('returns null when file does not exist in any supported location', () => {
    const home = tmpDir('home-missing');

    stubHomedir(home);
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    delete require.cache[require.resolve('./roo-code.js')];
    const rooCode = require('./roo-code.js');

    assert.equal(rooCode.discover(), null);
  });
});

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

    const minimal = result.find((s) => s.key === 'minimal');
    assert.equal(minimal.command, 'node');
    assert.deepStrictEqual(minimal.args, ['server.js']);
    assert.equal(minimal.timeout, undefined);
    assert.equal(minimal.type, undefined);
    assert.equal(minimal.disabled, undefined);
    assert.equal(minimal.alwaysAllow, undefined);
    assert.equal(minimal.env, undefined);

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

    const parsed = rooCode.parseMcpServers(p, originalConfig);
    const configObj = rooCode.writeMcpServers(parsed);

    const originalServers = originalConfig.mcpServers;
    const roundTrippedServers = configObj.mcpServers;

    assert.deepStrictEqual(roundTrippedServers['full-server'], originalServers['full-server']);
    assert.deepStrictEqual(roundTrippedServers['partial-server'], originalServers['partial-server']);
    assert.deepStrictEqual(roundTrippedServers['minimal-server'], originalServers['minimal-server']);

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
