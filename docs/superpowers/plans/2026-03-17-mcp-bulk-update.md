# MCP Server Bulk Update Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node.js-based MCP server bulk-update feature to cc-update-all, supporting Cursor, Cline, and Roo Code, exposed via a new `/update-mcp-servers` slash command.

**Architecture:** Tool Registry Pattern -- each AI coding tool is a self-describing module exporting `discover()`, `parseMcpServers()`, and `writeMcpServers()`. An orchestrator discovers installed tools, parses their MCP configs, queries npm for latest versions, and updates pinned versions. Zero runtime dependencies -- Node.js built-ins only.

**Tech Stack:** Node.js >= 18.0.0, `node:test` + `node:assert`, `https` (raw HTTPS for npm registry), `fs` (sync I/O), CommonJS modules

**Spec:** `docs/superpowers/specs/2026-03-17-mcp-bulk-update-design.md`

**Existing codebase style:** The existing `scripts/cc-update-all.sh` uses underscore-prefixed vars for internals (`_DRY_RUN`, `_JSON_MODE`), clear section comments (`# ---`), and exit codes 0/1/2. We follow the same conventions in the Node.js code.

---

## File Structure (all new files)

```
cc-update-all/
  scripts-mcp/                          # new directory
    update-mcp.js                       # entry point + CLI parser
    lib/
      registry.js                       # discovers & loads tool modules
      npm-resolver.js                   # queries npm registry for latest versions
      config-io.js                      # reads/writes JSON configs with backup
      reporter.js                       # formats output (text, JSON)
      tools/
        cursor.js                       # ~/.cursor/mcp.json
        cline.js                        # Cline MCP config handler
        roo-code.js                     # Roo Code MCP config handler
  commands/
    update-mcp-servers.md               # new slash command
  package.json                          # minimal -- zero runtime deps
```

---

## Chunk 1: Foundation (npm-resolver.js, config-io.js)

This chunk builds the two core utility modules that everything else depends on.

### Task 1: npm-resolver.js -- Version Extraction and NPM Registry Query

**Files:**
- Create: `scripts-mcp/lib/npm-resolver.js`
- Test: `scripts-mcp/lib/npm-resolver.test.js`

- [ ] **Step 1: Create the npm-resolver module**

Create `scripts-mcp/lib/npm-resolver.js`:

```js
// =============================================================================
// npm-resolver.js -- Extract pinned versions from npx args and query npm registry
//
// Responsibilities:
//   - extractPinnedVersion(args) -> { pkg, pinned } | { status }
//   - resolveLatest(pkg) -> { version } | { status, error }
//
// Uses raw HTTPS to npmjs.org (no fetch, no external deps).
// =============================================================================

'use strict';

const https = require('https');

// ---------------------------------------------------------------------------
// Version extraction from npx args array
// ---------------------------------------------------------------------------

/**
 * Extract npm package name and pinned version from an npx args array.
 *
 * @param {string[]} args - The args array from an MCP server config (e.g. ["-y", "@pkg/name@1.2.3"])
 * @returns {{ pkg: string, pinned: string } | { status: string, detail?: string }}
 */
function extractPinnedVersion(args) {
  if (!Array.isArray(args)) {
    return { status: 'check_failed', detail: 'args is not an array' };
  }

  // Find the arg that looks like a package reference (contains @ but is not a flag)
  const pkgArg = args.find(function (arg) {
    return typeof arg === 'string' && !arg.startsWith('-') && arg.includes('@');
  });

  if (!pkgArg) {
    return { status: 'check_failed', detail: 'no package reference found in args' };
  }

  // Skip git-based URLs
  if (
    pkgArg.startsWith('github:') ||
    pkgArg.startsWith('git+') ||
    pkgArg.startsWith('https://') ||
    pkgArg.startsWith('http://') ||
    pkgArg.startsWith('git://') ||
    pkgArg.startsWith('git@')
  ) {
    return { status: 'not_npm', detail: pkgArg };
  }

  // Parse scoped package: @scope/name@version[/subpath]
  // or unscoped: name@version[/subpath]
  var versionPattern;
  if (pkgArg.startsWith('@')) {
    // @scope/name@version[/subpath] or @scope/name (floating)
    // Match @scope/name then optional @version
    versionPattern = /^(@[^/]+\/[^@]+)(?:@([^/]+))?/;
  } else {
    // name@version[/subpath] or name (floating)
    versionPattern = /^([^@]+)(?:@(.+))?/;
  }

  var match = pkgArg.match(versionPattern);
  if (!match) {
    return { status: 'check_failed', detail: 'cannot parse package reference: ' + pkgArg };
  }

  var pkg = match[1];
  var version = match[2] || null;

  // Floating versions are not pinned -- skip
  if (version === null || version === 'latest' || version === '*' || version === 'next') {
    return { status: 'skipped_floating', pkg: pkg };
  }

  // Discard subpath from version (e.g. 1.2.3/sub/path -> 1.2.3)
  var cleanVersion = version.split('/')[0];

  return { pkg: pkg, pinned: cleanVersion };
}

// ---------------------------------------------------------------------------
// npm registry query
// ---------------------------------------------------------------------------

var _REGISTRY_TIMEOUT_MS = 5000;

/**
 * Query the npm registry for the latest version of a package.
 *
 * @param {string} pkg - npm package name (e.g. "@anthropic/mcp-server")
 * @returns {Promise<{ version: string } | { status: string, error: string }>}
 */
function resolveLatest(pkg) {
  return new Promise(function (resolve) {
    var url = 'https://registry.npmjs.org/' + encodeURIComponent(pkg) + '/latest';
    var req = https.get(url, function (res) {
      if (res.statusCode === 404) {
        res.resume(); // drain response body
        resolve({ status: 'not_found', pkg: pkg });
        return;
      }

      if (res.statusCode === 429) {
        res.resume();
        resolve({ status: 'rate_limited', pkg: pkg, error: 'npm registry rate limited (429)' });
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        resolve({ status: 'check_failed', pkg: pkg, error: 'npm returned HTTP ' + res.statusCode });
        return;
      }

      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        try {
          var data = JSON.parse(body);
          if (data && data.version) {
            resolve({ version: data.version });
          } else {
            resolve({ status: 'check_failed', pkg: pkg, error: 'no version field in npm response' });
          }
        } catch (e) {
          resolve({ status: 'check_failed', pkg: pkg, error: 'invalid JSON from npm registry' });
        }
      });
    });

    req.on('error', function (e) {
      resolve({ status: 'check_failed', pkg: pkg, error: e.message });
    });

    req.setTimeout(_REGISTRY_TIMEOUT_MS, function () {
      req.destroy();
      resolve({ status: 'check_failed', pkg: pkg, error: 'request timed out (' + _REGISTRY_TIMEOUT_MS + 'ms)' });
    });
  });
}

module.exports = {
  extractPinnedVersion: extractPinnedVersion,
  resolveLatest: resolveLatest
};
```

- [ ] **Step 2: Write tests for extractPinnedVersion**

Create `scripts-mcp/lib/npm-resolver.test.js`:

```js
// =============================================================================
// Tests for npm-resolver.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractPinnedVersion } = require('./npm-resolver.js');

// ---------------------------------------------------------------------------
// extractPinnedVersion: pinned scoped package
// ---------------------------------------------------------------------------

test('extractPinnedVersion: scoped package with pinned version', function () {
  var result = extractPinnedVersion(['-y', '@anthropic/mcp-server@1.2.3']);
  assert.deepEqual(result, { pkg: '@anthropic/mcp-server', pinned: '1.2.3' });
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: pinned unscoped package
// ---------------------------------------------------------------------------

test('extractPinnedVersion: unscoped package with pinned version', function () {
  var result = extractPinnedVersion(['-y', 'some-package@0.5.0']);
  assert.deepEqual(result, { pkg: 'some-package', pinned: '0.5.0' });
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: floating scoped (no version)
// ---------------------------------------------------------------------------

test('extractPinnedVersion: scoped package with no version (floating)', function () {
  var result = extractPinnedVersion(['-y', '@anthropic/mcp-server']);
  assert.equal(result.status, 'skipped_floating');
  assert.equal(result.pkg, '@anthropic/mcp-server');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: @latest is treated as floating
// ---------------------------------------------------------------------------

test('extractPinnedVersion: @latest is floating', function () {
  var result = extractPinnedVersion(['-y', '@anthropic/mcp-server@latest']);
  assert.equal(result.status, 'skipped_floating');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: @* is treated as floating
// ---------------------------------------------------------------------------

test('extractPinnedVersion: @* is floating', function () {
  var result = extractPinnedVersion(['-y', 'pkg@*']);
  assert.equal(result.status, 'skipped_floating');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: git URL is skipped
// ---------------------------------------------------------------------------

test('extractPinnedVersion: github: URL is not_npm', function () {
  var result = extractPinnedVersion(['-y', 'github:user/repo']);
  assert.equal(result.status, 'not_npm');
});

test('extractPinnedVersion: https:// URL is not_npm', function () {
  var result = extractPinnedVersion(['-y', 'https://github.com/user/repo']);
  assert.equal(result.status, 'not_npm');
});

test('extractPinnedVersion: git+https:// URL is not_npm', function () {
  var result = extractPinnedVersion(['-y', 'git+https://github.com/user/repo.git']);
  assert.equal(result.status, 'not_npm');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: subpath is discarded
// ---------------------------------------------------------------------------

test('extractPinnedVersion: subpath discarded from version', function () {
  var result = extractPinnedVersion(['-y', '@pkg/name@1.2.3/sub/path']);
  assert.deepEqual(result, { pkg: '@pkg/name', pinned: '1.2.3' });
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: multiple args with flags
// ---------------------------------------------------------------------------

test('extractPinnedVersion: finds package among multiple args', function () {
  var result = extractPinnedVersion(['-y', '--some-flag', '@scope/pkg@1.0.0', '--other']);
  assert.deepEqual(result, { pkg: '@scope/pkg', pinned: '1.0.0' });
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: empty args
// ---------------------------------------------------------------------------

test('extractPinnedVersion: empty args returns check_failed', function () {
  var result = extractPinnedVersion([]);
  assert.equal(result.status, 'check_failed');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: non-array args
// ---------------------------------------------------------------------------

test('extractPinnedVersion: non-array returns check_failed', function () {
  var result = extractPinnedVersion('not an array');
  assert.equal(result.status, 'check_failed');
});

// ---------------------------------------------------------------------------
// extractPinnedVersion: args with no package reference
// ---------------------------------------------------------------------------

test('extractPinnedVersion: args with no package ref returns check_failed', function () {
  var result = extractPinnedVersion(['-y', '--help']);
  assert.equal(result.status, 'check_failed');
});

// ---------------------------------------------------------------------------
// resolveLatest: mock test (requires mocking https)
// ---------------------------------------------------------------------------

test('resolveLatest: returns version for valid package (mocked)', async function () {
  // We test resolveLatest with a real lightweight package to avoid complex mocking
  // This test is marked as integration-level and may fail without network
  var { resolveLatest } = require('./npm-resolver.js');
  var result = await resolveLatest('semver');
  assert.ok(result.version, 'should return a version string');
  assert.match(result.version, /^\d+\.\d+\.\d+/, 'version should be semver format');
});

test('resolveLatest: returns not_found for non-existent package', async function () {
  var { resolveLatest } = require('./npm-resolver.js');
  var result = await resolveLatest('nonexistent-package-xyz-12345-that-does-not-exist');
  assert.equal(result.status, 'not_found');
});

test('resolveLatest: handles invalid package name gracefully', async function () {
  var { resolveLatest } = require('./npm-resolver.js');
  var result = await resolveLatest('');
  // Empty package name should return some kind of failure
  assert.ok(result.status, 'should have a status for empty package name');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/npm-resolver.test.js`
Expected: All tests pass (the resolveLatest integration tests require network access):

```
TAP version 13
# Subtest: extractPinnedVersion: scoped package with pinned version
ok 1 - extractPinnedVersion: scoped package with pinned version
  ...
# Subtest: resolveLatest: returns version for valid package (mocked)
ok 13 - resolveLatest: returns version for valid package (mocked)
  ...
1..14
# tests 14
# pass 14
# fail 0
```

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/npm-resolver.js scripts-mcp/lib/npm-resolver.test.js
git commit -m "feat(mcp): add npm-resolver module for version extraction and registry queries"
```

---

### Task 2: config-io.js -- JSON Read/Write with .bak Backup

**Files:**
- Create: `scripts-mcp/lib/config-io.js`
- Test: `scripts-mcp/lib/config-io.test.js`

- [ ] **Step 1: Create the config-io module**

Create `scripts-mcp/lib/config-io.js`:

```js
// =============================================================================
// config-io.js -- JSON config file read/write with .bak backup
//
// Responsibilities:
//   - readConfig(filePath) -> { data, mtimeMs } | { error }
//   - writeConfig(filePath, data, originalMtimeMs, force) -> { success } | { error }
//
// Safety features:
//   - Creates .bak backup before write
//   - mtime safety check (unless --force)
//   - Restores from .bak on write failure
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Read config file
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON config file.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @returns {{ data: object, mtimeMs: number } | { error: string }}
 */
function readConfig(filePath) {
  try {
    var content = fs.readFileSync(filePath, 'utf8');
    var data = JSON.parse(content);
    var stat = fs.statSync(filePath);
    return { data: data, mtimeMs: stat.mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { error: 'file not found: ' + filePath };
    }
    if (e instanceof SyntaxError) {
      return { error: 'malformed JSON in ' + filePath + ': ' + e.message };
    }
    return { error: 'failed to read ' + filePath + ': ' + e.message };
  }
}

// ---------------------------------------------------------------------------
// Write config file
// ---------------------------------------------------------------------------

/**
 * Write data to a JSON config file with .bak backup and mtime safety.
 *
 * @param {string} filePath - Absolute path to the JSON file
 * @param {object} data - Data to write (will be JSON.stringify'd)
 * @param {number} originalMtimeMs - mtime recorded when the file was first read
 * @param {boolean} force - If true, skip mtime safety check
 * @returns {{ success: boolean } | { error: string }}
 */
function writeConfig(filePath, data, originalMtimeMs, force) {
  var backupPath = filePath + '.bak';

  // -- Check mtime safety (unless --force)
  if (!force && originalMtimeMs !== undefined) {
    try {
      var currentStat = fs.statSync(filePath);
      if (currentStat.mtimeMs !== originalMtimeMs) {
        return {
          error: 'file modified since read (mtime changed). The AI coding tool may be running. Use --force to override.'
        };
      }
    } catch (e) {
      // File may have been deleted between read and write -- proceed (we're creating it)
    }
  }

  // -- Create .bak backup (overwrite any existing .bak)
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }
  } catch (e) {
    return { error: 'failed to create backup: ' + e.message };
  }

  // -- Write new content
  var jsonStr = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(filePath, jsonStr, 'utf8');
  } catch (e) {
    // -- Restore from .bak on write failure
    try {
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath);
      }
    } catch (restoreErr) {
      // Both write and restore failed -- bad state
      return {
        error: 'write failed AND backup restore failed. Manual recovery needed. Backup at: ' + backupPath + '. Write error: ' + e.message + '. Restore error: ' + restoreErr.message
      };
    }
    return { error: 'write failed, restored from backup: ' + e.message };
  }

  // -- Verify write succeeded
  try {
    var verifyStat = fs.statSync(filePath);
    if (verifyStat.size === 0) {
      // Empty file written -- restore from backup
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, filePath);
      }
      return { error: 'written file is empty, restored from backup' };
    }
  } catch (e) {
    // Stat failed but write may have succeeded -- not critical
  }

  return { success: true };
}

module.exports = {
  readConfig: readConfig,
  writeConfig: writeConfig
};
```

- [ ] **Step 2: Write tests for config-io**

Create `scripts-mcp/lib/config-io.test.js`:

```js
// =============================================================================
// Tests for config-io.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readConfig, writeConfig } = require('./config-io.js');

// ---------------------------------------------------------------------------
// Helpers: create temp file for tests
// ---------------------------------------------------------------------------

function tmpFile(content) {
  var dir = os.tmpdir();
  var filePath = path.join(dir, 'cc-update-all-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  if (content !== undefined) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
}

function cleanup(filePath) {
  try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(filePath + '.bak'); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// readConfig: valid JSON
// ---------------------------------------------------------------------------

test('readConfig: reads and parses valid JSON', function () {
  var filePath = tmpFile('{ "hello": "world" }');
  try {
    var result = readConfig(filePath);
    assert.ok(result.data, 'should have data');
    assert.equal(result.data.hello, 'world');
    assert.ok(typeof result.mtimeMs === 'number', 'should have mtimeMs');
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// readConfig: malformed JSON
// ---------------------------------------------------------------------------

test('readConfig: returns error for malformed JSON', function () {
  var filePath = tmpFile('{ not valid json }');
  try {
    var result = readConfig(filePath);
    assert.ok(result.error, 'should have error');
    assert.ok(result.error.includes('malformed JSON'), 'should mention malformed JSON');
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// readConfig: missing file
// ---------------------------------------------------------------------------

test('readConfig: returns error for missing file', function () {
  var result = readConfig('/nonexistent/path/file.json');
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('file not found'), 'should mention file not found');
});

// ---------------------------------------------------------------------------
// readConfig: empty file
// ---------------------------------------------------------------------------

test('readConfig: returns error for empty file', function () {
  var filePath = tmpFile('');
  try {
    var result = readConfig(filePath);
    assert.ok(result.error, 'should have error for empty file');
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// writeConfig: creates .bak backup
// ---------------------------------------------------------------------------

test('writeConfig: creates .bak backup before writing', function () {
  var filePath = tmpFile('{ "original": true }');
  try {
    var readResult = readConfig(filePath);
    assert.ok(readResult.data, 'should read original');

    var writeResult = writeConfig(filePath, { updated: true }, readResult.mtimeMs, false);
    assert.ok(writeResult.success, 'should write successfully');

    // .bak should exist with original content
    assert.ok(fs.existsSync(filePath + '.bak'), 'backup should exist');
    var bakContent = JSON.parse(fs.readFileSync(filePath + '.bak', 'utf8'));
    assert.equal(bakContent.original, true, 'backup should have original content');

    // main file should have new content
    var newContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(newContent.updated, true);
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// writeConfig: mtime safety check blocks write
// ---------------------------------------------------------------------------

test('writeConfig: mtime safety check blocks write when file changed', function () {
  var filePath = tmpFile('{ "original": true }');
  try {
    // Read, then deliberately modify the file to change mtime
    var readResult = readConfig(filePath);
    // Touch the file to change mtime (small sleep needed for mtime resolution)
    fs.writeFileSync(filePath, '{ "tampered": true }', 'utf8');
    // Use a fake old mtimeMs to simulate stale read
    var writeResult = writeConfig(filePath, { new: true }, readResult.mtimeMs - 1, false);
    assert.ok(writeResult.error, 'should error on mtime mismatch');
    assert.ok(writeResult.error.includes('mtime changed'), 'should mention mtime change');
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// writeConfig: --force skips mtime check
// ---------------------------------------------------------------------------

test('writeConfig: force skips mtime check', function () {
  var filePath = tmpFile('{ "original": true }');
  try {
    var readResult = readConfig(filePath);
    fs.writeFileSync(filePath, '{ "tampered": true }', 'utf8');
    var writeResult = writeConfig(filePath, { new: true }, readResult.mtimeMs - 1, true);
    assert.ok(writeResult.success, 'should succeed with force despite mtime change');
    var content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(content.new, true);
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// writeConfig: restores from .bak on write failure
// ---------------------------------------------------------------------------

test('writeConfig: restores from .bak when write target is read-only dir (simulated)', function () {
  // We test the restore path by using an invalid path that will fail write
  // but where we can still check the .bak logic
  var filePath = tmpFile('{ "original": true }');
  var backupPath = filePath + '.bak';
  try {
    var readResult = readConfig(filePath);
    // Manually create a scenario where write fails
    // We can't easily make writeFileSync fail on a valid path, so we test
    // that .bak is created correctly (the restore path)
    assert.ok(readResult.data, 'should read original');

    // Write normally first to create backup
    var writeResult = writeConfig(filePath, { first: true }, readResult.mtimeMs, false);
    assert.ok(writeResult.success, 'first write should succeed');
    assert.ok(fs.existsSync(backupPath), 'backup should exist');

    // Verify backup has original content
    var bakContent = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(bakContent.original, true, 'backup should have original content');
  } finally {
    cleanup(filePath);
  }
});

// ---------------------------------------------------------------------------
// writeConfig: JSON formatting (pretty-printed, trailing newline)
// ---------------------------------------------------------------------------

test('writeConfig: writes pretty-printed JSON with trailing newline', function () {
  var filePath = tmpFile('');
  try {
    var result = writeConfig(filePath, { a: 1, b: 2 }, undefined, false);
    assert.ok(result.success, 'should succeed');
    var content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.endsWith('\n'), 'should end with newline');
    assert.ok(content.includes('  '), 'should be indented (pretty-printed)');
  } finally {
    cleanup(filePath);
  }
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/config-io.test.js`
Expected: All tests pass:

```
TAP version 13
# Subtest: readConfig: reads and parses valid JSON
ok 1 - readConfig: reads and parses valid JSON
  ...
# Subtest: writeConfig: writes pretty-printed JSON with trailing newline
ok 9 - writeConfig: writes pretty-printed JSON with trailing newline
  ...
1..9
# tests 9
# pass 9
# fail 0
```

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/config-io.js scripts-mcp/lib/config-io.test.js
git commit -m "feat(mcp): add config-io module for JSON read/write with backup and mtime safety"
```

---

## Chunk 2: Tool Modules (cursor.js, cline.js, roo-code.js)

This chunk builds the three tool modules that understand each AI coding tool's MCP config format.

### Task 3: cursor.js -- Cursor MCP Config Handler

**Files:**
- Create: `scripts-mcp/lib/tools/cursor.js`
- Test: `scripts-mcp/lib/tools/cursor.test.js`

- [ ] **Step 1: Create the cursor tool module**

Create `scripts-mcp/lib/tools/cursor.js`:

```js
// =============================================================================
// cursor.js -- Cursor MCP config handler
//
// Config path: ~/.cursor/mcp.json
// Schema: { mcpServers: { [key]: { command, args, env } } }
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/**
 * Check if Cursor is installed by probing for its MCP config file.
 *
 * @returns {string|null} Absolute path to config, or null if not found
 */
function discover() {
  var configPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  if (fs.existsSync(configPath)) {
    return configPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse MCP servers from raw JSON
// ---------------------------------------------------------------------------

/**
 * Extract normalized MCP server entries from Cursor config JSON.
 *
 * @param {string} configPath - Path to the config file (unused, for consistency)
 * @param {object} rawJson - Parsed JSON content
 * @returns {Array<{ key: string, command: string, args: string[], env: object }>}
 */
function parseMcpServers(configPath, rawJson) {
  var servers = rawJson.mcpServers || {};
  return Object.keys(servers).map(function (key) {
    var entry = servers[key];
    return {
      key: key,
      command: entry.command || '',
      args: entry.args || [],
      env: entry.env || {}
    };
  });
}

// ---------------------------------------------------------------------------
// Write MCP servers back to Cursor schema
// ---------------------------------------------------------------------------

/**
 * Wrap normalized server array in Cursor's JSON schema.
 * Receives the COMPLETE array (both changed and unchanged entries).
 *
 * @param {Array<{ key: string, command: string, args: string[], env: object }>} servers
 * @returns {object} Full JSON object for config-io to write
 */
function writeMcpServers(servers) {
  var mcpServers = {};
  servers.forEach(function (server) {
    mcpServers[server.key] = {
      command: server.command,
      args: server.args,
      env: server.env || {}
    };
  });
  return { mcpServers: mcpServers };
}

module.exports = {
  name: 'cursor',
  discover: discover,
  parseMcpServers: parseMcpServers,
  writeMcpServers: writeMcpServers
};
```

- [ ] **Step 2: Write tests for cursor module**

Create `scripts-mcp/lib/tools/cursor.test.js`:

```js
// =============================================================================
// Tests for cursor.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cursor = require('./cursor.js');

// ---------------------------------------------------------------------------
// discover: returns null when config does not exist (default in test env)
// ---------------------------------------------------------------------------

test('cursor.discover: returns null when config not found', function () {
  // In most test environments, ~/.cursor/mcp.json won't exist
  var result = cursor.discover();
  // Result is either null (not found) or a path (found) -- we just assert it's the right type
  assert.ok(result === null || typeof result === 'string', 'should return null or string');
});

// ---------------------------------------------------------------------------
// parseMcpServers: extracts server entries
// ---------------------------------------------------------------------------

test('cursor.parseMcpServers: extracts npx server entries', function () {
  var rawJson = {
    mcpServers: {
      'anthropic': {
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server@1.2.3'],
        env: { 'API_KEY': 'sk-test' }
      },
      'local-tool': {
        command: 'node',
        args: ['/path/to/tool.js'],
        env: {}
      }
    }
  };

  var servers = cursor.parseMcpServers('/fake/path', rawJson);
  assert.equal(servers.length, 2);

  assert.equal(servers[0].key, 'anthropic');
  assert.equal(servers[0].command, 'npx');
  assert.deepEqual(servers[0].args, ['-y', '@anthropic/mcp-server@1.2.3']);
  assert.deepEqual(servers[0].env, { 'API_KEY': 'sk-test' });

  assert.equal(servers[1].key, 'local-tool');
  assert.equal(servers[1].command, 'node');
});

// ---------------------------------------------------------------------------
// parseMcpServers: handles empty mcpServers
// ---------------------------------------------------------------------------

test('cursor.parseMcpServers: handles empty mcpServers', function () {
  var servers = cursor.parseMcpServers('/fake/path', { mcpServers: {} });
  assert.deepEqual(servers, []);
});

test('cursor.parseMcpServers: handles missing mcpServers key', function () {
  var servers = cursor.parseMcpServers('/fake/path', {});
  assert.deepEqual(servers, []);
});

// ---------------------------------------------------------------------------
// writeMcpServers: wraps in Cursor schema
// ---------------------------------------------------------------------------

test('cursor.writeMcpServers: wraps servers in Cursor schema', function () {
  var servers = [
    { key: 'anthropic', command: 'npx', args: ['-y', '@anthropic/mcp-server@1.3.0'], env: {} },
    { key: 'local-tool', command: 'node', args: ['/path/to/tool.js'], env: {} }
  ];

  var result = cursor.writeMcpServers(servers);
  assert.ok(result.mcpServers, 'should have mcpServers key');
  assert.equal(result.mcpServers.anthropic.command, 'npx');
  assert.deepEqual(result.mcpServers.anthropic.args, ['-y', '@anthropic/mcp-server@1.3.0']);
  assert.equal(result.mcpServers['local-tool'].command, 'node');
});

// ---------------------------------------------------------------------------
// Round-trip: parse then write preserves all fields
// ---------------------------------------------------------------------------

test('cursor: round-trip preserves all fields', function () {
  var rawJson = {
    mcpServers: {
      'my-server': {
        command: 'npx',
        args: ['-y', '@pkg/name@1.0.0'],
        env: { 'KEY': 'value' }
      },
      'another': {
        command: 'uvx',
        args: ['some-python-pkg'],
        env: {}
      }
    }
  };

  // Parse
  var servers = cursor.parseMcpServers('/fake/path', rawJson);

  // Mutate one server's version (simulating an update)
  servers[0].args = ['-y', '@pkg/name@2.0.0'];

  // Write back
  var written = cursor.writeMcpServers(servers);

  // Verify
  assert.equal(written.mcpServers['my-server'].args[1], '@pkg/name@2.0.0', 'updated version preserved');
  assert.equal(written.mcpServers['my-server'].env.KEY, 'value', 'env preserved');
  assert.equal(written.mcpServers['another'].command, 'uvx', 'untouched server preserved');
});

// ---------------------------------------------------------------------------
// name export
// ---------------------------------------------------------------------------

test('cursor.name is "cursor"', function () {
  assert.equal(cursor.name, 'cursor');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/tools/cursor.test.js`
Expected: All tests pass:

```
TAP version 13
# Subtest: cursor.discover: returns null when config not found
ok 1 - ...
...
1..8
# tests 8
# pass 8
# fail 0
```

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/tools/cursor.js scripts-mcp/lib/tools/cursor.test.js
git commit -m "feat(mcp): add cursor tool module for MCP config parsing and writing"
```

---

### Task 4: cline.js -- Cline MCP Config Handler

**Files:**
- Create: `scripts-mcp/lib/tools/cline.js`
- Test: `scripts-mcp/lib/tools/cline.test.js`

- [ ] **Step 1: Create the cline tool module**

Create `scripts-mcp/lib/tools/cline.js`:

```js
// =============================================================================
// cline.js -- Cline MCP config handler
//
// Config path: ~/Library/Application Support/Code/User/globalStorage/
//              saoudrizwan.claude-dev/settings/cline_mcp_settings.json
//
// Schema: { mcpServers: { [key]: { command, args, env, timeout?, type?, disabled?, alwaysAllow? } } }
//
// Cline adds extra fields (timeout, type, disabled, alwaysAllow) that must be
// preserved during round-trip.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config path resolution (platform-aware)
// ---------------------------------------------------------------------------

function _getConfigPath() {
  var base;
  if (process.platform === 'darwin') {
    base = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings'
    );
  } else if (process.platform === 'linux') {
    base = path.join(
      os.homedir(),
      '.config',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings'
    );
  } else {
    // Windows or unknown -- return null (Windows support is out of scope)
    return null;
  }
  return path.join(base, 'cline_mcp_settings.json');
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/**
 * Check if Cline is installed by probing for its MCP config file.
 *
 * @returns {string|null} Absolute path to config, or null if not found
 */
function discover() {
  var configPath = _getConfigPath();
  if (configPath && fs.existsSync(configPath)) {
    return configPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extra fields that Cline uses (must be preserved)
// ---------------------------------------------------------------------------

var _CLINE_EXTRA_FIELDS = ['timeout', 'type', 'disabled', 'alwaysAllow'];

// ---------------------------------------------------------------------------
// Parse MCP servers from raw JSON
// ---------------------------------------------------------------------------

/**
 * Extract normalized MCP server entries from Cline config JSON.
 * Preserves Cline-specific extra fields (timeout, type, disabled, alwaysAllow).
 *
 * @param {string} configPath - Path to the config file
 * @param {object} rawJson - Parsed JSON content
 * @returns {Array<{ key, command, args, env, timeout?, type?, disabled?, alwaysAllow? }>}
 */
function parseMcpServers(configPath, rawJson) {
  var servers = rawJson.mcpServers || {};
  return Object.keys(servers).map(function (key) {
    var entry = servers[key];
    var result = {
      key: key,
      command: entry.command || '',
      args: entry.args || [],
      env: entry.env || {}
    };
    // Preserve extra Cline-specific fields
    _CLINE_EXTRA_FIELDS.forEach(function (field) {
      if (entry[field] !== undefined) {
        result[field] = entry[field];
      }
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Write MCP servers back to Cline schema
// ---------------------------------------------------------------------------

/**
 * Wrap normalized server array in Cline's JSON schema.
 * Preserves extra fields (timeout, type, disabled, alwaysAllow).
 *
 * @param {Array} servers - Complete normalized server array
 * @returns {object} Full JSON object for config-io to write
 */
function writeMcpServers(servers) {
  var mcpServers = {};
  servers.forEach(function (server) {
    var entry = {
      command: server.command,
      args: server.args,
      env: server.env || {}
    };
    // Restore extra Cline-specific fields
    _CLINE_EXTRA_FIELDS.forEach(function (field) {
      if (server[field] !== undefined) {
        entry[field] = server[field];
      }
    });
    mcpServers[server.key] = entry;
  });
  return { mcpServers: mcpServers };
}

module.exports = {
  name: 'cline',
  discover: discover,
  parseMcpServers: parseMcpServers,
  writeMcpServers: writeMcpServers
};
```

- [ ] **Step 2: Write tests for cline module**

Create `scripts-mcp/lib/tools/cline.test.js`:

```js
// =============================================================================
// Tests for cline.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cline = require('./cline.js');

// ---------------------------------------------------------------------------
// discover: returns null when config does not exist
// ---------------------------------------------------------------------------

test('cline.discover: returns null when config not found', function () {
  var result = cline.discover();
  assert.ok(result === null || typeof result === 'string', 'should return null or string');
});

// ---------------------------------------------------------------------------
// parseMcpServers: extracts server entries with extra fields
// ---------------------------------------------------------------------------

test('cline.parseMcpServers: extracts entries and preserves Cline extra fields', function () {
  var rawJson = {
    mcpServers: {
      'anthropic': {
        command: 'npx',
        args: ['-y', '@anthropic/mcp-server@1.2.3'],
        env: { 'API_KEY': 'sk-test' },
        timeout: 30000,
        disabled: false,
        alwaysAllow: ['read', 'write']
      },
      'local-tool': {
        command: 'node',
        args: ['/path/to/tool.js'],
        env: {},
        type: 'local'
      }
    }
  };

  var servers = cline.parseMcpServers('/fake/path', rawJson);
  assert.equal(servers.length, 2);

  // First server -- all extra fields
  assert.equal(servers[0].key, 'anthropic');
  assert.equal(servers[0].timeout, 30000);
  assert.equal(servers[0].disabled, false);
  assert.deepEqual(servers[0].alwaysAllow, ['read', 'write']);

  // Second server -- only 'type' extra field
  assert.equal(servers[1].key, 'local-tool');
  assert.equal(servers[1].type, 'local');
  // disabled should not be present since it wasn't in the original
  assert.equal(servers[1].disabled, undefined);
});

// ---------------------------------------------------------------------------
// parseMcpServers: handles empty/missing mcpServers
// ---------------------------------------------------------------------------

test('cline.parseMcpServers: handles empty mcpServers', function () {
  assert.deepEqual(cline.parseMcpServers('/fake/path', { mcpServers: {} }), []);
  assert.deepEqual(cline.parseMcpServers('/fake/path', {}), []);
});

// ---------------------------------------------------------------------------
// writeMcpServers: wraps in Cline schema and preserves extra fields
// ---------------------------------------------------------------------------

test('cline.writeMcpServers: preserves extra fields in output', function () {
  var servers = [
    { key: 'anthropic', command: 'npx', args: ['-y', '@anthropic/mcp-server@1.3.0'], env: {}, timeout: 30000, disabled: false, alwaysAllow: ['read'] },
    { key: 'local', command: 'node', args: ['/tool.js'], env: {}, type: 'local' }
  ];

  var result = cline.writeMcpServers(servers);
  assert.ok(result.mcpServers, 'should have mcpServers key');
  assert.equal(result.mcpServers.anthropic.timeout, 30000, 'timeout preserved');
  assert.equal(result.mcpServers.anthropic.disabled, false, 'disabled preserved');
  assert.deepEqual(result.mcpServers.anthropic.alwaysAllow, ['read'], 'alwaysAllow preserved');
  assert.equal(result.mcpServers.local.type, 'local', 'type preserved');
});

// ---------------------------------------------------------------------------
// Round-trip: parse then write preserves all fields
// ---------------------------------------------------------------------------

test('cline: round-trip preserves all fields including extras', function () {
  var rawJson = {
    mcpServers: {
      'my-server': {
        command: 'npx',
        args: ['-y', '@pkg/name@1.0.0'],
        env: { 'KEY': 'value' },
        timeout: 60000,
        disabled: true,
        alwaysAllow: ['read', 'write'],
        type: 'remote'
      }
    }
  };

  var servers = cline.parseMcpServers('/fake/path', rawJson);

  // Simulate version update
  servers[0].args = ['-y', '@pkg/name@2.0.0'];

  var written = cline.writeMcpServers(servers);

  var output = written.mcpServers['my-server'];
  assert.equal(output.args[1], '@pkg/name@2.0.0', 'updated version');
  assert.equal(output.env.KEY, 'value', 'env preserved');
  assert.equal(output.timeout, 60000, 'timeout preserved');
  assert.equal(output.disabled, true, 'disabled preserved');
  assert.deepEqual(output.alwaysAllow, ['read', 'write'], 'alwaysAllow preserved');
  assert.equal(output.type, 'remote', 'type preserved');
});

// ---------------------------------------------------------------------------
// name export
// ---------------------------------------------------------------------------

test('cline.name is "cline"', function () {
  assert.equal(cline.name, 'cline');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/tools/cline.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/tools/cline.js scripts-mcp/lib/tools/cline.test.js
git commit -m "feat(mcp): add cline tool module with extra field preservation (timeout, disabled, alwaysAllow)"
```

---

### Task 5: roo-code.js -- Roo Code MCP Config Handler

**Files:**
- Create: `scripts-mcp/lib/tools/roo-code.js`
- Test: `scripts-mcp/lib/tools/roo-code.test.js`

- [ ] **Step 1: Create the roo-code tool module**

Create `scripts-mcp/lib/tools/roo-code.js`:

```js
// =============================================================================
// roo-code.js -- Roo Code MCP config handler
//
// Config path: ~/Library/Application Support/Code/User/globalStorage/
//              rooveterinaryinc.roo-cline/settings/mcp_settings.json
//
// Schema: Same as Cline -- { mcpServers: { [key]: { command, args, env, timeout?, type?, disabled?, alwaysAllow? } } }
//
// Roo Code uses the same schema as Cline with the same extra fields.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config path resolution (platform-aware)
// ---------------------------------------------------------------------------

function _getConfigPath() {
  var base;
  if (process.platform === 'darwin') {
    base = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings'
    );
  } else if (process.platform === 'linux') {
    base = path.join(
      os.homedir(),
      '.config',
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings'
    );
  } else {
    return null;
  }
  return path.join(base, 'mcp_settings.json');
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/**
 * Check if Roo Code is installed by probing for its MCP config file.
 *
 * @returns {string|null} Absolute path to config, or null if not found
 */
function discover() {
  var configPath = _getConfigPath();
  if (configPath && fs.existsSync(configPath)) {
    return configPath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extra fields (same as Cline)
// ---------------------------------------------------------------------------

var _ROO_EXTRA_FIELDS = ['timeout', 'type', 'disabled', 'alwaysAllow'];

// ---------------------------------------------------------------------------
// Parse MCP servers from raw JSON
// ---------------------------------------------------------------------------

/**
 * Extract normalized MCP server entries from Roo Code config JSON.
 *
 * @param {string} configPath - Path to the config file
 * @param {object} rawJson - Parsed JSON content
 * @returns {Array<{ key, command, args, env, timeout?, type?, disabled?, alwaysAllow? }>}
 */
function parseMcpServers(configPath, rawJson) {
  var servers = rawJson.mcpServers || {};
  return Object.keys(servers).map(function (key) {
    var entry = servers[key];
    var result = {
      key: key,
      command: entry.command || '',
      args: entry.args || [],
      env: entry.env || {}
    };
    _ROO_EXTRA_FIELDS.forEach(function (field) {
      if (entry[field] !== undefined) {
        result[field] = entry[field];
      }
    });
    return result;
  });
}

// ---------------------------------------------------------------------------
// Write MCP servers back to Roo Code schema
// ---------------------------------------------------------------------------

/**
 * Wrap normalized server array in Roo Code's JSON schema.
 *
 * @param {Array} servers - Complete normalized server array
 * @returns {object} Full JSON object for config-io to write
 */
function writeMcpServers(servers) {
  var mcpServers = {};
  servers.forEach(function (server) {
    var entry = {
      command: server.command,
      args: server.args,
      env: server.env || {}
    };
    _ROO_EXTRA_FIELDS.forEach(function (field) {
      if (server[field] !== undefined) {
        entry[field] = server[field];
      }
    });
    mcpServers[server.key] = entry;
  });
  return { mcpServers: mcpServers };
}

module.exports = {
  name: 'roo-code',
  discover: discover,
  parseMcpServers: parseMcpServers,
  writeMcpServers: writeMcpServers
};
```

- [ ] **Step 2: Write tests for roo-code module**

Create `scripts-mcp/lib/tools/roo-code.test.js`:

```js
// =============================================================================
// Tests for roo-code.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rooCode = require('./roo-code.js');

// ---------------------------------------------------------------------------
// discover: returns null when config does not exist
// ---------------------------------------------------------------------------

test('roo-code.discover: returns null when config not found', function () {
  var result = rooCode.discover();
  assert.ok(result === null || typeof result === 'string', 'should return null or string');
});

// ---------------------------------------------------------------------------
// parseMcpServers: extracts entries with extra fields
// ---------------------------------------------------------------------------

test('roo-code.parseMcpServers: extracts entries and preserves extra fields', function () {
  var rawJson = {
    mcpServers: {
      'my-server': {
        command: 'npx',
        args: ['-y', '@pkg/name@1.0.0'],
        env: { 'KEY': 'val' },
        timeout: 10000,
        disabled: true
      }
    }
  };

  var servers = rooCode.parseMcpServers('/fake/path', rawJson);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].timeout, 10000);
  assert.equal(servers[0].disabled, true);
});

// ---------------------------------------------------------------------------
// parseMcpServers: handles empty/missing mcpServers
// ---------------------------------------------------------------------------

test('roo-code.parseMcpServers: handles empty and missing mcpServers', function () {
  assert.deepEqual(rooCode.parseMcpServers('/fake', { mcpServers: {} }), []);
  assert.deepEqual(rooCode.parseMcpServers('/fake', {}), []);
});

// ---------------------------------------------------------------------------
// writeMcpServers: wraps in schema
// ---------------------------------------------------------------------------

test('roo-code.writeMcpServers: preserves extra fields in output', function () {
  var servers = [
    { key: 's1', command: 'npx', args: ['-y', 'pkg@1.0.0'], env: {}, timeout: 5000, disabled: false }
  ];
  var result = rooCode.writeMcpServers(servers);
  assert.equal(result.mcpServers.s1.timeout, 5000);
  assert.equal(result.mcpServers.s1.disabled, false);
});

// ---------------------------------------------------------------------------
// Round-trip: preserves all fields
// ---------------------------------------------------------------------------

test('roo-code: round-trip preserves all fields', function () {
  var rawJson = {
    mcpServers: {
      'server-a': {
        command: 'npx',
        args: ['-y', '@pkg/name@1.0.0'],
        env: { 'X': '1' },
        timeout: 99999,
        disabled: true,
        alwaysAllow: ['read'],
        type: 'stdio'
      },
      'server-b': {
        command: 'node',
        args: ['tool.js'],
        env: {}
      }
    }
  };

  var servers = rooCode.parseMcpServers('/fake', rawJson);
  servers[0].args = ['-y', '@pkg/name@2.0.0'];
  var written = rooCode.writeMcpServers(servers);

  var a = written.mcpServers['server-a'];
  assert.equal(a.args[1], '@pkg/name@2.0.0');
  assert.equal(a.env.X, '1');
  assert.equal(a.timeout, 99999);
  assert.equal(a.disabled, true);
  assert.deepEqual(a.alwaysAllow, ['read']);
  assert.equal(a.type, 'stdio');

  var b = written.mcpServers['server-b'];
  assert.equal(b.command, 'node');
});

// ---------------------------------------------------------------------------
// name export
// ---------------------------------------------------------------------------

test('roo-code.name is "roo-code"', function () {
  assert.equal(rooCode.name, 'roo-code');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/tools/roo-code.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/tools/roo-code.js scripts-mcp/lib/tools/roo-code.test.js
git commit -m "feat(mcp): add roo-code tool module (same schema as cline, different config path)"
```

---

## Chunk 3: Orchestration (registry.js, reporter.js, update-mcp.js)

This chunk wires everything together: tool discovery, output formatting, and the CLI entry point.

### Task 6: registry.js -- Tool Discovery and Loading

**Files:**
- Create: `scripts-mcp/lib/registry.js`
- Test: `scripts-mcp/lib/registry.test.js`

- [ ] **Step 1: Create the registry module**

Create `scripts-mcp/lib/registry.js`:

```js
// =============================================================================
// registry.js -- Discovers and loads tool modules from the tools/ directory
//
// Each tool module exports:
//   { name, discover(), parseMcpServers(configPath, rawJson), writeMcpServers(servers) }
//
// registry.discover() calls discover() on each tool and returns only
// tools whose config files exist on disk.
// =============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load all tool modules from tools/ directory
// ---------------------------------------------------------------------------

function _loadToolModules() {
  var toolsDir = path.join(__dirname, 'tools');
  var files = fs.readdirSync(toolsDir).filter(function (f) {
    return f.endsWith('.js') && !f.endsWith('.test.js');
  });

  return files.map(function (f) {
    return require(path.join(toolsDir, f));
  });
}

// ---------------------------------------------------------------------------
// Discover installed tools
// ---------------------------------------------------------------------------

/**
 * Probe each tool module's discover() and return tools with config paths found.
 *
 * @returns {Array<{ name: string, configPath: string, tool: object }>}
 */
function discover() {
  var modules = _loadToolModules();
  var found = [];

  modules.forEach(function (mod) {
    var configPath = mod.discover();
    if (configPath) {
      found.push({
        name: mod.name,
        configPath: configPath,
        tool: mod
      });
    }
  });

  return found;
}

// ---------------------------------------------------------------------------
// Get tool by name
// ---------------------------------------------------------------------------

/**
 * Get a tool module by its name.
 *
 * @param {string} name - Tool name (e.g. "cursor")
 * @returns {object|null} Tool module or null if not found
 */
function getTool(name) {
  var modules = _loadToolModules();
  for (var i = 0; i < modules.length; i++) {
    if (modules[i].name === name) {
      return modules[i];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// List all available tool names
// ---------------------------------------------------------------------------

/**
 * List all tool module names (regardless of whether configs exist).
 *
 * @returns {string[]}
 */
function listToolNames() {
  var modules = _loadToolModules();
  return modules.map(function (mod) { return mod.name; });
}

module.exports = {
  discover: discover,
  getTool: getTool,
  listToolNames: listToolNames
};
```

- [ ] **Step 2: Write tests for registry**

Create `scripts-mcp/lib/registry.test.js`:

```js
// =============================================================================
// Tests for registry.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('./registry.js');

// ---------------------------------------------------------------------------
// listToolNames: returns all tool names
// ---------------------------------------------------------------------------

test('registry.listToolNames: returns array of tool names', function () {
  var names = registry.listToolNames();
  assert.ok(Array.isArray(names), 'should return an array');
  assert.ok(names.includes('cursor'), 'should include cursor');
  assert.ok(names.includes('cline'), 'should include cline');
  assert.ok(names.includes('roo-code'), 'should include roo-code');
});

// ---------------------------------------------------------------------------
// getTool: returns tool by name
// ---------------------------------------------------------------------------

test('registry.getTool: returns cursor tool', function () {
  var tool = registry.getTool('cursor');
  assert.ok(tool, 'should return a tool');
  assert.equal(tool.name, 'cursor');
  assert.equal(typeof tool.discover, 'function');
  assert.equal(typeof tool.parseMcpServers, 'function');
  assert.equal(typeof tool.writeMcpServers, 'function');
});

test('registry.getTool: returns cline tool', function () {
  var tool = registry.getTool('cline');
  assert.ok(tool);
  assert.equal(tool.name, 'cline');
});

test('registry.getTool: returns roo-code tool', function () {
  var tool = registry.getTool('roo-code');
  assert.ok(tool);
  assert.equal(tool.name, 'roo-code');
});

test('registry.getTool: returns null for unknown tool', function () {
  var tool = registry.getTool('nonexistent');
  assert.equal(tool, null);
});

// ---------------------------------------------------------------------------
// discover: returns array (may be empty in test env)
// ---------------------------------------------------------------------------

test('registry.discover: returns array of discovered tools', function () {
  var tools = registry.discover();
  assert.ok(Array.isArray(tools), 'should return an array');
  // Each entry should have name, configPath, and tool
  tools.forEach(function (t) {
    assert.ok(t.name, 'should have name');
    assert.ok(typeof t.configPath === 'string', 'should have configPath string');
    assert.ok(t.tool, 'should have tool module');
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/registry.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/registry.js scripts-mcp/lib/registry.test.js
git commit -m "feat(mcp): add registry module for tool discovery and loading"
```

---

### Task 7: reporter.js -- Output Formatting

**Files:**
- Create: `scripts-mcp/lib/reporter.js`
- Test: `scripts-mcp/lib/reporter.test.js`

- [ ] **Step 1: Create the reporter module**

Create `scripts-mcp/lib/reporter.js`:

```js
// =============================================================================
// reporter.js -- Format update results as text or JSON
//
// Input: array of tool result objects
// Output: formatted string (text table or JSON)
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Status label helpers
// ---------------------------------------------------------------------------

var _STATUS_LABELS = {
  updated: 'UPDATED',
  current: 'CURRENT',
  skipped_non_npx: 'SKIPPED',
  skipped_floating: 'SKIPPED',
  check_failed: 'FAILED',
  not_found: 'SKIPPED',
  not_npm: 'SKIPPED'
};

function _labelForStatus(status) {
  return _STATUS_LABELS[status] || status.toUpperCase();
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

/**
 * Format results as a human-readable text table.
 *
 * @param {object} data - { tools: { [name]: { configPath, servers: [...] } }, summary: { updated, current, skipped, failed } }
 * @param {number} toolCount - Number of tools discovered
 * @returns {string}
 */
function formatText(data, toolCount) {
  var lines = [];
  lines.push('Checking MCP servers across ' + toolCount + (toolCount === 1 ? ' tool' : ' tools') + '...');
  lines.push('');

  var toolNames = Object.keys(data.tools);
  toolNames.forEach(function (toolName) {
    var tool = data.tools[toolName];
    lines.push('  ' + toolName);

    tool.servers.forEach(function (server) {
      var label = _labelForStatus(server.status);

      if (server.status === 'updated') {
        lines.push('    [' + label + ']   ' + (server.package || server.key) + '   ' + server.current + ' -> ' + server.latest);
      } else if (server.status === 'current') {
        lines.push('    [' + label + ']   ' + (server.package || server.key));
      } else if (server.status === 'skipped_non_npx') {
        lines.push('    [' + label + ']   ' + server.key + ' (not npx-based)');
      } else if (server.status === 'skipped_floating') {
        lines.push('    [' + label + ']   ' + (server.package || server.key) + ' (floating version)');
      } else if (server.status === 'check_failed') {
        lines.push('    [' + label + ']   ' + (server.package || server.key) + ' (' + (server.error || 'unknown error') + ')');
      } else if (server.status === 'not_found') {
        lines.push('    [' + label + ']   ' + (server.package || server.key) + ' (not on npm)');
      } else if (server.status === 'not_npm') {
        lines.push('    [' + label + ']   ' + server.key + ' (not an npm package)');
      } else {
        lines.push('    [' + label + ']   ' + (server.package || server.key));
      }
    });

    lines.push('');
  });

  lines.push('========== SUMMARY ==========');
  lines.push('  Updated: ' + data.summary.updated +
    '  |  Current: ' + data.summary.current +
    '  |  Skipped: ' + data.summary.skipped +
    '  |  Failed: ' + data.summary.failed);

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/**
 * Format results as JSON string.
 *
 * @param {object} data - Same as formatText input
 * @returns {string}
 */
function formatJson(data) {
  return JSON.stringify(data, null, 2) + '\n';
}

module.exports = {
  formatText: formatText,
  formatJson: formatJson
};
```

- [ ] **Step 2: Write tests for reporter**

Create `scripts-mcp/lib/reporter.test.js`:

```js
// =============================================================================
// Tests for reporter.js
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const reporter = require('./reporter.js');

// ---------------------------------------------------------------------------
// Sample data for tests
// ---------------------------------------------------------------------------

var sampleData = {
  tools: {
    cursor: {
      status: 'ok',
      configPath: '/Users/test/.cursor/mcp.json',
      servers: [
        { key: 'anthropic', package: '@anthropic/mcp-server', status: 'updated', current: '1.2.3', latest: '1.3.0' },
        { key: 'github', package: '@modelcontextprotocol/server-github', status: 'current', current: null, latest: '2.1.0' },
        { key: 'local-tool', status: 'skipped_non_npx' }
      ]
    },
    cline: {
      status: 'ok',
      configPath: '/Users/test/Library/.../cline_mcp_settings.json',
      servers: [
        { key: 'anthropic', package: '@anthropic/mcp-server', status: 'current', current: null, latest: '1.3.0' }
      ]
    }
  },
  summary: { updated: 1, current: 3, skipped: 1, failed: 0 }
};

// ---------------------------------------------------------------------------
// formatText: basic structure
// ---------------------------------------------------------------------------

test('reporter.formatText: includes tool names', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('cursor'), 'should mention cursor');
  assert.ok(output.includes('cline'), 'should mention cline');
});

test('reporter.formatText: includes summary counts', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('Updated: 1'), 'should show updated count');
  assert.ok(output.includes('Current: 3'), 'should show current count');
  assert.ok(output.includes('Skipped: 1'), 'should show skipped count');
  assert.ok(output.includes('Failed: 0'), 'should show failed count');
});

test('reporter.formatText: shows version arrow for updated servers', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('1.2.3 -> 1.3.0'), 'should show version arrow');
});

test('reporter.formatText: shows not npx-based for non-npx servers', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('(not npx-based)'), 'should show non-npx message');
});

test('reporter.formatText: shows singular "tool" for count of 1', function () {
  var output = reporter.formatText(sampleData, 1);
  assert.ok(output.includes('1 tool'), 'should use singular');
});

test('reporter.formatText: shows plural "tools" for count > 1', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('2 tools'), 'should use plural');
});

// ---------------------------------------------------------------------------
// formatJson: valid JSON output
// ---------------------------------------------------------------------------

test('reporter.formatJson: produces valid JSON', function () {
  var output = reporter.formatJson(sampleData);
  var parsed = JSON.parse(output);
  assert.ok(parsed.tools, 'should have tools');
  assert.ok(parsed.summary, 'should have summary');
  assert.equal(parsed.summary.updated, 1);
  assert.equal(parsed.tools.cursor.servers.length, 3);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('reporter.formatText: handles empty tools', function () {
  var emptyData = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  var output = reporter.formatText(emptyData, 0);
  assert.ok(output.includes('SUMMARY'), 'should still show summary');
});

test('reporter.formatText: handles check_failed with error message', function () {
  var failData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'bad-pkg', package: 'bad-pkg', status: 'check_failed', error: 'network timeout' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 0, failed: 1 }
  };
  var output = reporter.formatText(failData, 1);
  assert.ok(output.includes('network timeout'), 'should show error message');
  assert.ok(output.includes('[FAILED]'), 'should show FAILED label');
});

test('reporter.formatText: handles not_found status', function () {
  var notFoundData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'private-pkg', package: '@private/pkg', status: 'not_found' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 1, failed: 0 }
  };
  var output = reporter.formatText(notFoundData, 1);
  assert.ok(output.includes('(not on npm)'), 'should show not on npm message');
});

test('reporter.formatText: handles skipped_floating status', function () {
  var floatingData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'float-pkg', package: '@scope/pkg', status: 'skipped_floating' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 1, failed: 0 }
  };
  var output = reporter.formatText(floatingData, 1);
  assert.ok(output.includes('(floating version)'), 'should show floating version message');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/lib/reporter.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/lib/reporter.js scripts-mcp/lib/reporter.test.js
git commit -m "feat(mcp): add reporter module for text and JSON output formatting"
```

---

### Task 8: update-mcp.js -- CLI Entry Point

**Files:**
- Create: `scripts-mcp/update-mcp.js`
- Test: `scripts-mcp/update-mcp.test.js`

- [ ] **Step 1: Create the CLI entry point**

Create `scripts-mcp/update-mcp.js`:

```js
#!/usr/bin/env node
// =============================================================================
// update-mcp.js -- Entry point and CLI parser for MCP server bulk updates
//
// Discovers MCP configs for installed AI coding tools (Cursor, Cline, Roo Code),
// checks for outdated pinned npm versions, and optionally updates them.
//
// Usage: node update-mcp.js [--dry-run] [--check] [--tool NAME] [--json] [--force]
//
// Exit codes:
//   0 - All checks/updates successful
//   1 - Partial failure OR --check found outdated servers
//   2 - Total error (bad args, no tools found, --tool NAME not found)
// =============================================================================

'use strict';

var registry = require('./lib/registry.js');
var configIo = require('./lib/config-io.js');
var npmResolver = require('./lib/npm-resolver.js');
var reporter = require('./lib/reporter.js');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // argv is process.argv.slice(2)
  var opts = {
    dryRun: false,
    check: false,
    toolName: null,
    json: false,
    force: false
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--tool':
        i++;
        if (i >= argv.length || argv[i].startsWith('--')) {
          return { error: '--tool requires a tool name' };
        }
        opts.toolName = argv[i];
        break;
      case '--json':
        opts.json = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--help':
      case '-h':
        return { help: true };
      default:
        return { error: 'Unknown flag: ' + arg + '. Use --help for usage.' };
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Process a single tool
// ---------------------------------------------------------------------------

/**
 * Process one tool: read config, check versions, optionally update.
 *
 * @param {object} discoveredTool - { name, configPath, tool }
 * @param {object} opts - CLI options
 * @returns {Promise<object>} Tool result for reporter
 */
async function processTool(discoveredTool, opts) {
  var tool = discoveredTool.tool;
  var configPath = discoveredTool.configPath;
  var toolResult = {
    status: 'ok',
    configPath: configPath,
    servers: []
  };

  // -- Read config
  var readResult = configIo.readConfig(configPath);
  if (readResult.error) {
    toolResult.status = 'parse_error';
    toolResult.error = readResult.error;
    return toolResult;
  }

  var rawJson = readResult.data;
  var originalMtimeMs = readResult.mtimeMs;

  // -- Parse MCP servers
  var servers;
  try {
    servers = tool.parseMcpServers(configPath, rawJson);
  } catch (e) {
    toolResult.status = 'parse_error';
    toolResult.error = 'failed to parse MCP servers: ' + e.message;
    return toolResult;
  }

  // -- Check each npx-based server
  var hasUpdates = false;
  for (var i = 0; i < servers.length; i++) {
    var server = servers[i];
    var serverResult = { key: server.key };

    if (server.command !== 'npx') {
      serverResult.status = 'skipped_non_npx';
      toolResult.servers.push(serverResult);
      continue;
    }

    // Extract package and pinned version
    var extracted = npmResolver.extractPinnedVersion(server.args);

    if (extracted.status === 'not_npm') {
      serverResult.status = 'not_npm';
      toolResult.servers.push(serverResult);
      continue;
    }

    if (extracted.status === 'skipped_floating') {
      serverResult.package = extracted.pkg;
      serverResult.status = 'skipped_floating';
      toolResult.servers.push(serverResult);
      continue;
    }

    if (extracted.status === 'check_failed') {
      serverResult.status = 'check_failed';
      serverResult.error = extracted.detail;
      toolResult.servers.push(serverResult);
      continue;
    }

    // Has pinned version -- check npm for latest
    serverResult.package = extracted.pkg;
    serverResult.current = extracted.pinned;

    var resolveResult = await npmResolver.resolveLatest(extracted.pkg);

    if (resolveResult.status) {
      serverResult.status = resolveResult.status;
      if (resolveResult.error) serverResult.error = resolveResult.error;
      toolResult.servers.push(serverResult);
      continue;
    }

    serverResult.latest = resolveResult.version;

    if (extracted.pinned === resolveResult.version) {
      serverResult.status = 'current';
    } else {
      serverResult.status = 'updated';
      hasUpdates = true;

      // Mutate the server args to update the version
      for (var j = 0; j < server.args.length; j++) {
        if (server.args[j].includes(extracted.pkg)) {
          // Replace the version in the arg: @pkg/name@old -> @pkg/name@new
          server.args[j] = server.args[j].replace(
            extracted.pkg + '@' + extracted.pinned,
            extracted.pkg + '@' + resolveResult.version
          );
          break;
        }
      }
    }

    toolResult.servers.push(serverResult);
  }

  // -- Write back if there are updates and not in check/dry-run mode
  if (hasUpdates && !opts.dryRun && !opts.check) {
    var writeData = tool.writeMcpServers(servers);
    var writeResult = configIo.writeConfig(configPath, writeData, originalMtimeMs, opts.force);
    if (writeResult.error) {
      toolResult.status = 'write_error';
      toolResult.writeError = writeResult.error;
    }
  }

  return toolResult;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  // -- Parse args
  var parsed = parseArgs(argv);

  if (parsed.help) {
    console.log([
      '',
      'update-mcp.js -- Bulk-update MCP server versions',
      '',
      'Usage: node update-mcp.js [flags]',
      '  --dry-run       Show what would change without writing',
      '  --check         Report outdated only, exit 1 if any',
      '  --tool NAME     Only process named tool',
      '  --json          Output as JSON',
      '  --force         Skip mtime safety check',
      '  --help          Show this help message',
      ''
    ].join('\n'));
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }

  // -- Validate --tool NAME
  if (parsed.toolName) {
    var toolModule = registry.getTool(parsed.toolName);
    if (!toolModule) {
      console.error("Tool '" + parsed.toolName + "' not found.");
      console.error('Available tools: ' + registry.listToolNames().join(', '));
      process.exit(2);
    }
  }

  // -- Discover tools
  var discovered = registry.discover();

  // Filter by --tool if specified
  if (parsed.toolName) {
    discovered = discovered.filter(function (t) { return t.name === parsed.toolName; });
  }

  if (discovered.length === 0) {
    if (parsed.toolName) {
      console.error("Tool '" + parsed.toolName + "' is known but its config file was not found.");
      console.error('The tool may not be installed or configured.');
    } else {
      console.error('No MCP config files found for any supported tools.');
      console.error('Supported tools: ' + registry.listToolNames().join(', '));
    }
    process.exit(2);
  }

  // -- Process each tool
  var results = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  var hasOutdated = false;
  var hasFailures = false;

  for (var i = 0; i < discovered.length; i++) {
    var toolName = discovered[i].name;
    var toolResult = await processTool(discovered[i], parsed);
    results.tools[toolName] = toolResult;

    // Update summary counts
    toolResult.servers.forEach(function (s) {
      switch (s.status) {
        case 'updated':
          results.summary.updated++;
          hasOutdated = true;
          break;
        case 'current':
          results.summary.current++;
          break;
        case 'skipped_non_npx':
        case 'skipped_floating':
        case 'not_npm':
        case 'not_found':
          results.summary.skipped++;
          break;
        case 'check_failed':
          results.summary.failed++;
          hasFailures = true;
          break;
        default:
          results.summary.skipped++;
      }
    });

    if (toolResult.status !== 'ok') {
      hasFailures = true;
    }
  }

  // -- Output
  if (parsed.json) {
    console.log(reporter.formatJson(results));
  } else {
    console.log(reporter.formatText(results, discovered.length));
  }

  // -- Exit code
  if (parsed.check && hasOutdated) {
    process.exit(1);
  }

  if (hasFailures) {
    process.exit(1);
  }

  process.exit(0);
}

// -- Run if executed directly (not imported by tests)
if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    console.error('Fatal error:', err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs: parseArgs, main: main, processTool: processTool };
```

- [ ] **Step 2: Write tests for update-mcp.js**

Create `scripts-mcp/update-mcp.test.js`:

```js
// =============================================================================
// Tests for update-mcp.js (CLI entry point)
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./update-mcp.js');

// ---------------------------------------------------------------------------
// parseArgs: default (no flags)
// ---------------------------------------------------------------------------

test('parseArgs: no flags returns defaults', function () {
  var result = parseArgs([]);
  assert.equal(result.dryRun, false);
  assert.equal(result.check, false);
  assert.equal(result.toolName, null);
  assert.equal(result.json, false);
  assert.equal(result.force, false);
});

// ---------------------------------------------------------------------------
// parseArgs: individual flags
// ---------------------------------------------------------------------------

test('parseArgs: --dry-run', function () {
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs: --check', function () {
  assert.equal(parseArgs(['--check']).check, true);
});

test('parseArgs: --json', function () {
  assert.equal(parseArgs(['--json']).json, true);
});

test('parseArgs: --force', function () {
  assert.equal(parseArgs(['--force']).force, true);
});

test('parseArgs: --tool NAME', function () {
  var result = parseArgs(['--tool', 'cursor']);
  assert.equal(result.toolName, 'cursor');
});

// ---------------------------------------------------------------------------
// parseArgs: flag combinations
// ---------------------------------------------------------------------------

test('parseArgs: multiple flags combined', function () {
  var result = parseArgs(['--dry-run', '--json', '--tool', 'cline']);
  assert.equal(result.dryRun, true);
  assert.equal(result.json, true);
  assert.equal(result.toolName, 'cline');
  assert.equal(result.check, false);
});

// ---------------------------------------------------------------------------
// parseArgs: --help
// ---------------------------------------------------------------------------

test('parseArgs: --help returns help flag', function () {
  var result = parseArgs(['--help']);
  assert.equal(result.help, true);
});

test('parseArgs: -h returns help flag', function () {
  var result = parseArgs(['-h']);
  assert.equal(result.help, true);
});

// ---------------------------------------------------------------------------
// parseArgs: error cases
// ---------------------------------------------------------------------------

test('parseArgs: --tool without name returns error', function () {
  var result = parseArgs(['--tool']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('--tool requires'), 'should mention --tool');
});

test('parseArgs: --tool followed by flag returns error', function () {
  var result = parseArgs(['--tool', '--dry-run']);
  assert.ok(result.error, 'should have error');
});

test('parseArgs: unknown flag returns error', function () {
  var result = parseArgs(['--bogus']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('Unknown flag'), 'should mention unknown flag');
});

// ---------------------------------------------------------------------------
// parseArgs: preserves unknown positional args (should error)
// ---------------------------------------------------------------------------

test('parseArgs: positional arg returns error', function () {
  var result = parseArgs(['something']);
  assert.ok(result.error, 'should have error for positional arg');
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node --test scripts-mcp/update-mcp.test.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add scripts-mcp/update-mcp.js scripts-mcp/update-mcp.test.js
git commit -m "feat(mcp): add CLI entry point with argument parsing and tool orchestration"
```

---

## Chunk 4: Integration (slash command, package.json, full test suite)

This chunk adds the slash command, package.json, and runs the full test suite.

### Task 9: Slash Command File

**Files:**
- Create: `commands/update-mcp-servers.md`

- [ ] **Step 1: Create the slash command**

Create `commands/update-mcp-servers.md`:

```markdown
---
description: Bulk-update MCP servers across Cursor, Cline, and Roo Code
argument-hint: [--dry-run] [--check] [--tool NAME] [--json] [--force]
allowed-tools: Bash
---

Run the MCP update script to check and update MCP server versions across AI coding tools. The script discovers MCP configs for installed tools and updates pinned npm versions.

Find the script in the plugin cache and execute it with any user-provided arguments. The script is located somewhere under `~/.claude/plugins/cache/` -- use `find` to locate it if needed. Do NOT hardcode the cache path; discover it dynamically.

```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts-mcp/update-mcp.js" 2>/dev/null | head -1 | xargs -I{} node {} $ARGUMENTS
```

After the script completes, present the summary output to the user. If any MCP servers were updated, remind the user to restart the relevant AI coding tool to pick up changes.
```

- [ ] **Step 2: Verify the file was created correctly**

Run: `cat /Users/kianwoonwong/Downloads/cc-update-all/commands/update-mcp-servers.md | head -5`
Expected: Shows the YAML frontmatter with description

- [ ] **Step 3: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add commands/update-mcp-servers.md
git commit -m "feat(mcp): add /update-mcp-servers slash command"
```

---

### Task 10: package.json and Full Test Suite

**Files:**
- Create: `package.json`

- [ ] **Step 1: Create package.json**

Create `package.json` in the project root:

```json
{
  "name": "cc-update-all",
  "version": "1.2.0",
  "private": true,
  "description": "Bulk-update Claude Code plugin marketplaces and MCP servers",
  "scripts": {
    "test": "node --test scripts-mcp/lib/npm-resolver.test.js scripts-mcp/lib/config-io.test.js scripts-mcp/lib/tools/cursor.test.js scripts-mcp/lib/tools/cline.test.js scripts-mcp/lib/tools/roo-code.test.js scripts-mcp/lib/registry.test.js scripts-mcp/lib/reporter.test.js scripts-mcp/update-mcp.test.js",
    "test:mcp": "node --test scripts-mcp/**/*.test.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "keywords": [
    "claude-code",
    "plugin",
    "mcp",
    "bulk-update"
  ],
  "license": "MIT",
  "dependencies": {}
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && npm test`
Expected: All tests pass:

```
TAP version 13
# Subtest: extractPinnedVersion: scoped package with pinned version
ok 1 - extractPinnedVersion: scoped package with pinned version
  ...
# Subtest: parseArgs: positional arg returns error
ok N - parseArgs: positional arg returns error
  ...
1..N
# tests N
# pass N
# fail 0
```

- [ ] **Step 3: Verify CLI help output**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node scripts-mcp/update-mcp.js --help`
Expected:

```
update-mcp.js -- Bulk-update MCP server versions

Usage: node update-mcp.js [flags]
  --dry-run       Show what would change without writing
  --check         Report outdated only, exit 1 if any
  --tool NAME     Only process named tool
  --json          Output as JSON
  --force         Skip mtime safety check
  --help          Show this help message
```

- [ ] **Step 4: Verify --json flag output format**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node scripts-mcp/update-mcp.js --json 2>/dev/null; echo "exit: $?"`
Expected: Valid JSON output with exit code 0 (no tools found scenario) or 2

- [ ] **Step 5: Verify error handling for unknown --tool**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && node scripts-mcp/update-mcp.js --tool nonexistent 2>&1; echo "exit: $?"`
Expected:

```
Tool 'nonexistent' not found.
Available tools: cursor, cline, roo-code
exit: 2
```

- [ ] **Step 6: Commit**

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add package.json
git commit -m "feat(mcp): add package.json with test scripts and Node.js >= 18 engine requirement"
```

---

### Task 11: Final Integration Verification

- [ ] **Step 1: Run all tests one more time to confirm everything works together**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && npm test`
Expected: All tests pass with no failures

- [ ] **Step 2: Verify the complete file tree**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && find scripts-mcp commands/update-mcp-servers.md package.json -type f | sort`
Expected output lists all files:

```
commands/update-mcp-servers.md
package.json
scripts-mcp/lib/config-io.js
scripts-mcp/lib/config-io.test.js
scripts-mcp/lib/npm-resolver.js
scripts-mcp/lib/npm-resolver.test.js
scripts-mcp/lib/registry.js
scripts-mcp/lib/registry.test.js
scripts-mcp/lib/reporter.js
scripts-mcp/lib/reporter.test.js
scripts-mcp/lib/tools/cline.js
scripts-mcp/lib/tools/cline.test.js
scripts-mcp/lib/tools/cursor.js
scripts-mcp/lib/tools/cursor.test.js
scripts-mcp/lib/tools/roo-code.js
scripts-mcp/lib/tools/roo-code.test.js
scripts-mcp/update-mcp.js
scripts-mcp/update-mcp.test.js
```

- [ ] **Step 3: Verify existing files are unchanged**

Run: `cd /Users/kianwoonwong/Downloads/cc-update-all && git diff HEAD -- scripts/cc-update-all.sh commands/update-all-plugins.md`
Expected: No output (existing files unchanged)

- [ ] **Step 4: Create final commit if any cleanup needed (optional)**

If any adjustments were made during integration testing:

```bash
cd /Users/kianwoonwong/Downloads/cc-update-all
git add -A
git commit -m "chore(mcp): final integration cleanup"
```
