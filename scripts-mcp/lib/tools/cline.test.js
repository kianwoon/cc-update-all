const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));

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

describe('cline', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
    cleanup();
  });
});

describe('cline discover()', () => {
  it('returns macOS configPath when file exists', () => {
    const home = tmpDir('home-macos');
    const configPath = path.join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');

    assert.equal(cline.discover(), configPath);
  });

  it('returns Linux configPath when file exists in XDG config home', () => {
    const home = tmpDir('home-linux');
    const xdgConfigHome = path.join(home, '.config');
    const configPath = path.join(
      xdgConfigHome,
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');

    assert.equal(cline.discover(), configPath);
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
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    );

    fs.rmSync(xdgConfigHome, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    stubHomedir(home);
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    process.env.APPDATA = appData;
    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');

    assert.equal(cline.discover(), configPath);
  });

  it('returns null when file does not exist in any supported location', () => {
    const home = tmpDir('home-missing');

    stubHomedir(home);
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');

    assert.equal(cline.discover(), null);
  });
});

describe('cline parseMcpServers()', () => {
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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.parseMcpServers('/some/path', rawJson);

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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.parseMcpServers('/some/path', rawJson);

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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 0);
    assert.ok(Array.isArray(result));
  });

  it('returns empty array for missing mcpServers key', () => {
    const rawJson = {};

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 0);
  });

  it('preserves env as an object (not just string values)', () => {
    const rawJson = {
      mcpServers: {
        withEnv: {
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { FOO: 'bar', BAZ: '123' },
          timeout: 45,
          type: 'sse',
          disabled: true,
          alwaysAllow: ['a', 'b', 'c'],
        },
      },
    };

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.parseMcpServers('/some/path', rawJson);

    assert.equal(result.length, 1);
    const entry = result[0];
    assert.deepStrictEqual(entry.env, { FOO: 'bar', BAZ: '123' });
    assert.equal(entry.timeout, 45);
    assert.equal(entry.type, 'sse');
    assert.equal(entry.disabled, true);
    assert.deepStrictEqual(entry.alwaysAllow, ['a', 'b', 'c']);
  });
});

describe('cline writeMcpServers()', () => {
  it('wraps in Cline schema preserving all extra fields', () => {
    const p = tmpFile('cline-write-full.json');
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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.writeMcpServers(servers, p);
    assert.equal(result.ok, true);

    const written = JSON.parse(readRaw(p));
    assert.ok(written.mcpServers, 'should have mcpServers key');
    assert.ok(written.mcpServers.anthropic, 'should have server entry');

    const server = written.mcpServers.anthropic;
    assert.equal(server.command, 'npx');
    assert.deepStrictEqual(server.args, ['-y', '@anthropic/mcp-server@1.2.3']);
    assert.deepStrictEqual(server.env, { API_KEY: 'test' });
    assert.equal(server.timeout, 60);
    assert.equal(server.type, 'stdio');
    assert.equal(server.disabled, false);
    assert.deepStrictEqual(server.alwaysAllow, ['tool1', 'tool2']);
  });

  it('writes only defined extra fields (no undefined pollution)', () => {
    const p = tmpFile('cline-write-minimal.json');
    const servers = [
      {
        key: 'minimal',
        command: 'node',
        args: ['server.js'],
      },
    ];

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.writeMcpServers(servers, p);
    assert.equal(result.ok, true);

    const written = JSON.parse(readRaw(p));
    const server = written.mcpServers.minimal;

    assert.equal(server.command, 'node');
    assert.deepStrictEqual(server.args, ['server.js']);
    assert.equal('timeout' in server, false, 'timeout should not be in output');
    assert.equal('type' in server, false, 'type should not be in output');
    assert.equal('disabled' in server, false, 'disabled should not be in output');
    assert.equal('alwaysAllow' in server, false, 'alwaysAllow should not be in output');
    assert.equal('env' in server, false, 'env should not be in output');
  });

  it('writes multiple servers', () => {
    const p = tmpFile('cline-write-multi.json');
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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.writeMcpServers(servers, p);
    assert.equal(result.ok, true);

    const written = JSON.parse(readRaw(p));
    assert.ok(written.mcpServers['server-a']);
    assert.ok(written.mcpServers['server-b']);

    assert.equal(written.mcpServers['server-a'].timeout, 30);
    assert.equal(written.mcpServers['server-a'].disabled, true);
    assert.deepStrictEqual(written.mcpServers['server-a'].alwaysAllow, []);

    assert.equal(written.mcpServers['server-b'].timeout, 120);
    assert.equal('disabled' in written.mcpServers['server-b'], false);
  });
});

describe('cline round-trip', () => {
  it('parse -> pass through -> write preserves all extra fields', () => {
    const p = tmpFile('cline-roundtrip.json');

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

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');

    const parsed = cline.parseMcpServers(p, originalConfig);
    const writeResult = cline.writeMcpServers(parsed, p);
    assert.equal(writeResult.ok, true);

    const roundTripped = JSON.parse(readRaw(p));
    const originalServers = originalConfig.mcpServers;
    const roundTrippedServers = roundTripped.mcpServers;

    // Full server: all fields preserved
    assert.deepStrictEqual(
      roundTrippedServers['full-server'],
      originalServers['full-server'],
      'full-server should have identical round-trip',
    );

    // Partial server: all present fields preserved, absent fields stay absent
    assert.deepStrictEqual(
      roundTrippedServers['partial-server'],
      originalServers['partial-server'],
      'partial-server should have identical round-trip',
    );

    // Minimal server: only basic fields preserved
    assert.deepStrictEqual(
      roundTrippedServers['minimal-server'],
      originalServers['minimal-server'],
      'minimal-server should have identical round-trip',
    );
  });
});
