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
      result.error.includes('malformed') || result.error.includes('JSON') || result.error.includes('parse'),
      `unexpected error: ${result.error}`,
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

  it('creates backup and cleans it up after successful write', function() {
    const p = tmpFile('backup-test.json');
    const original = { original: true };
    writeRaw(p, JSON.stringify(original, null, 2));

    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { updated: true });
    assert.equal(result.ok, true);

    // Backup should be cleaned up after successful write
    assert.ok(!fs.existsSync(p + '.bak'), 'backup removed after write');

    // Verify new content was written
    const written = JSON.parse(readRaw(p));
    assert.deepStrictEqual(written, { updated: true });
  });
  it('cleans up .tmp file after successful write', () => {
    const p = tmpFile('tmp-cleanup.json');
    writeRaw(p, '{}');

    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { clean: true });
    assert.equal(result.ok, true);
    assert.ok(!fs.existsSync(`${p}.tmp`), '.tmp should be removed after write');
  });

  it('succeeds when post-rename mtime matches .tmp mtime (no external modification)', () => {
    const p = tmpFile('mtime-ok-test.json');
    const original = { version: 1 };
    writeRaw(p, JSON.stringify(original, null, 2));

    // Normal write — no monkey-patching. The rename preserves .tmp's mtime,
    // so the post-rename stat should match, and writeConfig should succeed.
    const { writeConfig } = require('./config-io.js');
    const result = writeConfig(p, { version: 2 });
    assert.equal(result.ok, true, 'should succeed when mtime matches after rename');

    // Verify new content was written
    const written = JSON.parse(readRaw(p));
    assert.deepStrictEqual(written, { version: 2 });
  });

  it('restores from .bak when post-rename mtime differs (external modification detected)', () => {
    const p = tmpFile('mtime-conflict-test.json');
    const original = { version: 1, important: true };
    writeRaw(p, JSON.stringify(original, null, 2));

    // Monkey-patch fs.statSync to simulate an external process modifying the file
    // after our rename. We intercept the post-rename stat on configPath and return
    // a different mtime than what .tmp had, triggering the conflict path.
    const realStatSync = fs.statSync;
    let statInterceptTarget = null;
    let statInterceptValue = null;

    fs.statSync = function (...args) {
      const result = realStatSync.apply(this, args);
      if (statInterceptTarget && args[0] === statInterceptTarget) {
        result.mtimeMs = statInterceptValue;
      }
      return result;
    };

    // Intercept the stat on .tmp (step 4: record .tmp mtime) to capture a known value,
    // then intercept the stat on configPath (step 6: verification) to return a different value.
    statInterceptTarget = `${p}.tmp`;
    statInterceptValue = 1000000.0; // fake .tmp mtime

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

    assert.ok(!fs.existsSync(`${p}.bak`), '.bak should not exist for new files');
  });

  afterEach(() => cleanup());
});
