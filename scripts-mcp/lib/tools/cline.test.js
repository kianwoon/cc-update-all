const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-test-'));

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
    try {
      fs.unlinkSync(path.join(TMPDIR, file));
    } catch (_) {
      /* best effort */
    }
  }
}

// Minimal stub of readConfig that reads from real filesystem
// The actual module is imported inside each test so we can control the file state.
// We test against the real configPath by setting up files at the expected location
// via a tmpdir that we construct to mimic the real path structure.

describe('cline', () => {
  let cline;

  beforeEach(() => {
    // Fresh require each time to avoid cached state
    delete require.cache[require.resolve('./cline.js')];
    cline = require('./cline.js');
  });

  afterEach(() => cleanup());
});

// --- discover() tests ---

describe('cline discover()', () => {
  const configPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Code',
    'User',
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );

  it('returns configPath when file exists', () => {
    // Ensure the directory and file exist at the real Cline path
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    writeRaw(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    delete require.cache[require.resolve('./cline.js')];
    const cline = require('./cline.js');
    const result = cline.discover();

    assert.equal(result, configPath);

    // Cleanup: remove the real file we created
    try {
      fs.unlinkSync(configPath);
    } catch (_) {
      /* best effort */
    }
    // Attempt to clean up empty directories (best effort, ignore failures)
    try {
      fs.rmdirSync(path.dirname(configPath));
    } catch (_) {
      /* best effort */
    }
    try {
      fs.rmdirSync(path.dirname(path.dirname(configPath)));
    } catch (_) {
      /* best effort */
    }
  });

  it('returns null when file does not exist', () => {
    // We need to test with a non-existent path. To avoid depending on
    // whether the user's real Cline config exists, we temporarily rename
    // it if present, then restore after.
    let renamed = false;
    if (fs.existsSync(configPath)) {
      const bakPath = `${configPath}.testbak`;
      fs.renameSync(configPath, bakPath);
      renamed = true;
    }

    try {
      delete require.cache[require.resolve('./cline.js')];
      const cline = require('./cline.js');
      const result = cline.discover();

      assert.equal(result, null);
    } finally {
      if (renamed) {
        const bakPath = `${configPath}.testbak`;
        try {
          fs.renameSync(bakPath, configPath);
        } catch (_) {
          /* best effort */
        }
      }
    }
  });
});

// --- parseMcpServers() tests ---

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

    // Minimal server: extra fields should be undefined or have defaults
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

// --- writeMcpServers() tests ---

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
    // Extra fields should NOT be present as undefined
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

// --- Round-trip test ---

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

    // Parse
    const parsed = cline.parseMcpServers(p, originalConfig);

    // Write back
    const writeResult = cline.writeMcpServers(parsed, p);
    assert.equal(writeResult.ok, true);

    // Read back and verify
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
