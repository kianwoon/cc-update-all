'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'config-io-test-'));

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
    fs.unlinkSync(path.join(TMPDIR, file));
  }
}

// --- readConfig tests ---

describe('readConfig', () => {
  beforeEach(() => cleanup());

  it('reads and parses valid JSON', () => {
    const p = tmpFile('valid.json');
    const data = { mcpServers: { foo: { command: 'npx' } } };
    writeRaw(p, JSON.stringify(data, null, 2));

    const { readConfig } = require('./config-io.js');
    const result = readConfig(p);
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.data, data);
  });

  it('returns error for malformed JSON', () => {
    const p = tmpFile('malformed.json');
    writeRaw(p, '{ not valid json }');

    const { readConfig } = require('./config-io.js');
    const result = readConfig(p);
    assert.equal(result.ok, false);
    assert.ok(
      result.error.includes('malformed') ||
      result.error.includes('JSON') ||
      result.error.includes('parse'),
      `unexpected error: ${result.error}`
    );
  });

  it('returns error for non-existent file', () => {
    const p = tmpFile('does-not-exist.json');

    const { readConfig } = require('./config-io.js');
    const result = readConfig(p);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'), `unexpected error: ${result.error}`);
  });

  it('returns error for empty file', () => {
    const p = tmpFile('empty.json');
    writeRaw(p, '');

    const { readConfig } = require('./config-io.js');
    const result = readConfig(p);
    assert.equal(result.ok, false);
    assert.ok(result.error, 'error message should exist');
  });

  afterEach(() => cleanup());
});

// --- writeConfig tests ---

describe('writeConfig', () => {
  beforeEach(() => cleanup());

  it('creates .bak backup before writing', () => {
    const p = tmpFile('backup-test.json');
    const original = { original: true };
    writeRaw(p, JSON.stringify(original, null, 2));

    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { updated: true });
    assert.equal(result.ok, true);

    const bakContent = readRaw(p + '.bak');
    assert.deepStrictEqual(JSON.parse(bakContent), original);
  });

  it('writes correct content with trailing newline', () => {
    const p = tmpFile('content-test.json');
    writeRaw(p, '{}');

    const data = { mcpServers: { server1: { command: 'npx', args: ['-y', 'pkg@1.0.0'] } } };
    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, data);
    assert.equal(result.ok, true);

    const written = readRaw(p);
    assert.equal(written, JSON.stringify(data, null, 2) + '\n');
    assert.deepStrictEqual(JSON.parse(written), data);
  });

  it('cleans up .tmp file after successful write', () => {
    const p = tmpFile('tmp-cleanup.json');
    writeRaw(p, '{}');

    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { clean: true });
    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(p + '.tmp'), '.tmp should be removed after write');
  });

  it('restores from .bak on mtime conflict', () => {
    const p = tmpFile('mtime-test.json');
    const original = { version: 1, important: true };
    writeRaw(p, JSON.stringify(original, null, 2));

    const originalMtime = fs.statSync(p).mtimeMs;

    // Monkey-patch fs.statSync to simulate an external process restoring the file.
    // After writeConfig renames .tmp -> configPath, our patched statSync will return
    // the original mtime (as if someone overwrote the file back), triggering the conflict.
    const realStatSync = fs.statSync;
    let callCount = 0;
    fs.statSync = function (...args) {
      const result = realStatSync.apply(this, args);
      if (args[0] === p) {
        callCount++;
        // The second call is the post-write verification stat (step 5).
        // Return the original mtime to simulate external overwrite.
        if (callCount === 2) {
          result.mtimeMs = originalMtime;
        }
      }
      return result;
    };

    try {
      const { writeConfig } = require('./config-io.js');
      const result = writeConfig(p, { version: 2, important: false });
      assert.equal(result.ok, false, 'should return ok: false on mtime conflict');
      assert.ok(result.error.includes('mtime'), `unexpected error: ${result.error}`);

      // Verify original content was restored from .bak
      const restored = JSON.parse(readRaw(p));
      assert.deepStrictEqual(restored, original, 'original content should be restored from .bak');
    } finally {
      fs.statSync = realStatSync;
    }
  });

  it('returns ok: true on successful write', () => {
    const p = tmpFile('success.json');
    writeRaw(p, '{}');

    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { new: 'data' });
    assert.equal(result.ok, true);
  });

  it('handles write to new file (no existing content)', () => {
    const p = tmpFile('new-file.json');
    // File does not exist yet

    const data = { fresh: true };
    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, data);
    assert.equal(result.ok, true);

    const written = readRaw(p);
    assert.deepStrictEqual(JSON.parse(written), data);
  });

  it('does not create .bak for new files', () => {
    const p = tmpFile('no-bak-new.json');

    const { writeConfig } = require('./config-io.js');
    writeConfig(p, { test: true });

    assert.ok(!fs.existsSync(p + '.bak'), '.bak should not exist for new files');
  });

  afterEach(() => cleanup());
});
