const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// --- Helpers ---

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-test-'));

function tmpDir(name) {
  const dir = path.join(TMPDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tmpFile(dir, name) {
  return path.join(dir, name);
}

function writeRaw(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function cleanup() {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
}

// We need to override os.homedir so discover() uses our tmp dir instead
// of the real home directory.
const realHomedir = os.homedir;
let fakeHome = null;

function stubHomedir(tmpDir) {
  fakeHome = tmpDir;
  os.homedir = () => fakeHome;
}

function restoreHomedir() {
  os.homedir = realHomedir;
  fakeHome = null;
}

// Clear require cache before each test so we get a fresh module
function freshCursor() {
  delete require.cache[require.resolve('./cursor.js')];
  return require('./cursor.js');
}

// --- discover() tests ---

describe('cursor discover()', () => {
  beforeEach(() => {
    restoreHomedir();
  });

  afterEach(() => {
    restoreHomedir();
  });

  it('returns configPath when ~/.cursor/mcp.json exists', () => {
    const home = tmpDir('home-discover-exists');
    const cursorDir = path.join(home, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    writeRaw(path.join(cursorDir, 'mcp.json'), '{}');

    stubHomedir(home);
    const cursor = freshCursor();
    const result = cursor.discover();

    assert.ok(result !== null);
    assert.equal(result, path.join(home, '.cursor', 'mcp.json'));
  });

  it('returns null when ~/.cursor/mcp.json does not exist', () => {
    const home = tmpDir('home-discover-missing');
    // Don't create .cursor/mcp.json

    stubHomedir(home);
    const cursor = freshCursor();
    const result = cursor.discover();

    assert.equal(result, null);
  });
});

// --- parseMcpServers() tests ---

describe('cursor parseMcpServers()', () => {
  const cursor = freshCursor();

  it('extracts all server entries as normalized array', () => {
    const configPath = '/fake/path/mcp.json';
    const rawJson = {
      mcpServers: {
        anthropic: { command: 'npx', args: ['-y', '@anthropic/mcp-server@1.2.3'], env: {} },
        'local-tool': { command: 'node', args: ['/path/to/tool.js'] },
      },
    };

    const result = cursor.parseMcpServers(configPath, rawJson);

    assert.equal(result.length, 2);

    // Check first server
    assert.equal(result[0].key, 'anthropic');
    assert.equal(result[0].command, 'npx');
    assert.deepStrictEqual(result[0].args, ['-y', '@anthropic/mcp-server@1.2.3']);
    assert.deepStrictEqual(result[0].env, {});

    // Check second server (no env)
    assert.equal(result[1].key, 'local-tool');
    assert.equal(result[1].command, 'node');
    assert.deepStrictEqual(result[1].args, ['/path/to/tool.js']);
    assert.equal(result[1].env, undefined);
  });

  it('handles empty mcpServers object', () => {
    const configPath = '/fake/path/mcp.json';
    const rawJson = { mcpServers: {} };

    const result = cursor.parseMcpServers(configPath, rawJson);

    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('handles servers with extra unknown properties (preserves them)', () => {
    const configPath = '/fake/path/mcp.json';
    const rawJson = {
      mcpServers: {
        'my-server': { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: { KEY: 'val' }, disabled: true },
      },
    };

    const result = cursor.parseMcpServers(configPath, rawJson);

    assert.equal(result.length, 1);
    assert.equal(result[0].key, 'my-server');
    assert.equal(result[0].command, 'npx');
    assert.deepStrictEqual(result[0].args, ['-y', 'pkg@1.0.0']);
    assert.deepStrictEqual(result[0].env, { KEY: 'val' });
    assert.equal(result[0].disabled, true);
  });
});

// --- writeMcpServers() tests ---

describe('cursor writeMcpServers()', () => {
  const cursor = freshCursor();

  it('wraps servers in correct Cursor schema', () => {
    const servers = [
      { key: 'anthropic', command: 'npx', args: ['-y', '@anthropic/mcp-server@1.2.3'], env: {} },
      { key: 'local-tool', command: 'node', args: ['/path/to/tool.js'] },
    ];

    const result = cursor.writeMcpServers(servers);

    assert.ok(result.mcpServers);
    assert.equal(Object.keys(result.mcpServers).length, 2);

    // Verify first server
    assert.equal(result.mcpServers.anthropic.command, 'npx');
    assert.deepStrictEqual(result.mcpServers.anthropic.args, ['-y', '@anthropic/mcp-server@1.2.3']);
    assert.deepStrictEqual(result.mcpServers.anthropic.env, {});

    // Verify second server (no env)
    assert.equal(result.mcpServers['local-tool'].command, 'node');
    assert.deepStrictEqual(result.mcpServers['local-tool'].args, ['/path/to/tool.js']);
    // env should not be present if not in input
    assert.equal('env' in result.mcpServers['local-tool'], false);
  });

  it('returns empty mcpServers for empty array', () => {
    const result = cursor.writeMcpServers([]);

    assert.deepStrictEqual(result, { mcpServers: {} });
  });

  it('preserves extra properties on server entries', () => {
    const servers = [{ key: 'my-server', command: 'npx', args: ['-y', 'pkg@1.0.0'], disabled: true, label: 'My Tool' }];

    const result = cursor.writeMcpServers(servers);

    assert.equal(result.mcpServers['my-server'].disabled, true);
    assert.equal(result.mcpServers['my-server'].label, 'My Tool');
  });
});

// --- Round-trip tests ---

describe('cursor round-trip', () => {
  it('parse -> write produces same structure', () => {
    const cursor = freshCursor();
    const configPath = '/fake/path/mcp.json';

    const rawJson = {
      mcpServers: {
        anthropic: { command: 'npx', args: ['-y', '@anthropic/mcp-server@1.2.3'], env: {} },
        'local-tool': { command: 'node', args: ['/path/to/tool.js'] },
      },
    };

    // Parse
    const parsed = cursor.parseMcpServers(configPath, rawJson);

    // Write (pass through unchanged)
    const written = cursor.writeMcpServers(parsed);

    // Should match original structure
    assert.deepStrictEqual(written, rawJson);
  });

  it('round-trip preserves env when present', () => {
    const cursor = freshCursor();
    const configPath = '/fake/path/mcp.json';

    const rawJson = {
      mcpServers: {
        'env-server': { command: 'npx', args: ['-y', 'pkg@1.0.0'], env: { API_KEY: 'secret' } },
      },
    };

    const parsed = cursor.parseMcpServers(configPath, rawJson);
    const written = cursor.writeMcpServers(parsed);

    assert.deepStrictEqual(written, rawJson);
  });

  it('round-trip with modifications preserves unchanged entries', () => {
    const cursor = freshCursor();
    const configPath = '/fake/path/mcp.json';

    const rawJson = {
      mcpServers: {
        'keep-me': { command: 'node', args: ['/old/path.js'] },
        'update-me': { command: 'npx', args: ['-y', 'pkg@1.0.0'] },
      },
    };

    const parsed = cursor.parseMcpServers(configPath, rawJson);

    // Simulate updating one entry's args
    parsed[1].args = ['-y', 'pkg@2.0.0'];

    const written = cursor.writeMcpServers(parsed);

    // Unchanged entry preserved
    assert.deepStrictEqual(written.mcpServers['keep-me'], { command: 'node', args: ['/old/path.js'] });
    // Updated entry has new args
    assert.deepStrictEqual(written.mcpServers['update-me'].args, ['-y', 'pkg@2.0.0']);
  });
});
