# Extension Update Checker Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/update-extensions` slash command that checks Cursor and Windsurf extensions against the VS Code Marketplace API and reports which are outdated.

**Architecture:** Reuse the existing registry/reporter infrastructure. New `marketplace-resolver.js` handles batch Marketplace API queries. Two new tool modules (`cursor-extensions.js`, `windsurf-extensions.js`) parse `extensions.json` files. A new CLI entry point (`update-extensions.js`) orchestrates discovery + checking + reporting. Extension results align to the MCP result schema (`servers` array with `package`/`current`/`latest` fields) so `reporter.js` works without modification.

**Tech Stack:** Node.js >= 18.0.0 built-ins only (`https`, `fs`, `path`, `node:test`). Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-17-extension-update-check-design.md`

**Known UX imperfection:** `reporter.js` hardcodes "Checking MCP servers across N tools..." in its text output. Reusing it for extensions means the header will say "MCP servers" instead of "extensions". This is an accepted trade-off for zero-change reporter reuse. A future enhancement could add an optional label parameter to `formatText`.

---

## Chunk 1: Marketplace Resolver + Extension Tool Modules

### Task 1: marketplace-resolver.js — VS Code Marketplace API Client

**Files:**
- Create: `scripts-mcp/lib/marketplace-resolver.js`
- Test: `scripts-mcp/lib/marketplace-resolver.test.js`

This module sends batch extension version queries to the VS Code Marketplace API. It's the extension equivalent of `npm-resolver.js`.

- [ ] **Step 1: Write the failing tests**

Create `scripts-mcp/lib/marketplace-resolver.test.js`:

```js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');

// -------------------------------------------------------
// Stubs / helpers
// -------------------------------------------------------

let _originalRequest;
let _mockFactory;

function stubHttpsRequest(factory) {
  _mockFactory = factory;
  https.request = function (urlOrOpts, optsOrCb, maybeCb) {
    const url = typeof urlOrOpts === 'string' ? urlOrOpts : (urlOrOpts && urlOrOpts.href) || '';
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const opts = typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb : {};
    const req = _mockFactory(url, opts, cb);
    if (opts.timeout != null && typeof req.setTimeout === 'function') {
      req.setTimeout(opts.timeout);
    }
    return req;
  };
}

function restoreHttpsRequest() {
  https.request = _originalRequest;
}

function createMockRequest(statusCode, body, error, simulateTimeout) {
  let timeoutHandler = null;
  let errorHandler = null;

  const req = {
    destroy() {},
    setTimeout(ms) {
      if (simulateTimeout) {
        setTimeout(() => { if (timeoutHandler) timeoutHandler(); }, 20);
      }
      return this;
    },
    on(event, handler) {
      if (event === 'timeout') timeoutHandler = handler;
      else if (event === 'error') errorHandler = handler;
      return this;
    },
    write() { return this; },
    end() { return this; },
    abort() { return this; }
  };

  req._simulate = function (responseCallback) {
    setImmediate(() => {
      if (error && !simulateTimeout) {
        if (errorHandler) errorHandler(error);
        return;
      }
      if (simulateTimeout) return;

      const res = {
        statusCode,
        headers: {},
        on(event, handler) {
          if (event === 'data' && body) {
            setImmediate(() => handler(body));
          }
          if (event === 'end') {
            setImmediate(() => handler());
          }
          return this;
        }
      };

      if (responseCallback && statusCode !== null) {
        responseCallback(res);
      }
    });
  };

  return req;
}

// -------------------------------------------------------
// resolveLatest
// -------------------------------------------------------

describe('marketplace-resolver resolveLatest', () => {
  let resolveLatest;

  beforeEach(() => {
    delete require.cache[require.resolve('./marketplace-resolver')];
    _originalRequest = https.request;
    ({ resolveLatest } = require('./marketplace-resolver'));
  });

  afterEach(() => {
    restoreHttpsRequest();
  });

  it('returns map of extension IDs to latest versions on success', async () => {
    stubHttpsRequest((url, opts, cb) => {
      assert.ok(url.includes('marketplace.visualstudio.com'));
      assert.equal(opts.method, 'POST');
      const req = createMockRequest(200, JSON.stringify({
        results: [{
          extensions: [
            { extensionId: 'ext-1', extensionName: 'pylance', publisher: { publisherName: 'ms-python' },
              versions: [{ version: '2026.1.101' }] },
            { extensionId: 'ext-2', extensionName: 'macros', publisher: { publisherName: 'geddski' },
              versions: [{ version: '2.0.0' }] }
          ]
        }]
      }));
      req._simulate(cb);
      return req;
    });

    const ids = ['ms-python.vscode-pylance', 'geddski.macros'];
    const result = await resolveLatest(ids);

    assert.equal(result.status, 'ok');
    assert.equal(result.versions['ms-python.vscode-pylance'], '2026.1.101');
    assert.equal(result.versions['geddski.macros'], '2.0.0');
  });

  it('returns versions with id format publisher.extensionName', async () => {
    stubHttpsRequest((url, opts, cb) => {
      const req = createMockRequest(200, JSON.stringify({
        results: [{
          extensions: [
            { extensionId: 'ext-1', extensionName: 'pylance', publisher: { publisherName: 'ms-python' },
              versions: [{ version: '1.0.0' }] }
          ]
        }]
      }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['ms-python.vscode-pylance']);
    assert.equal(result.status, 'ok');
    assert.equal(result.versions['ms-python.vscode-pylance'], '1.0.0');
  });

  it('omits extensions not found in API response', async () => {
    stubHttpsRequest((url, opts, cb) => {
      // API only returns one of the two requested extensions
      const req = createMockRequest(200, JSON.stringify({
        results: [{
          extensions: [
            { extensionId: 'ext-1', extensionName: 'pylance', publisher: { publisherName: 'ms-python' },
              versions: [{ version: '1.0.0' }] }
          ]
        }]
      }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['ms-python.vscode-pylance', 'unknown.ext']);
    assert.equal(result.status, 'ok');
    assert.equal(result.versions['ms-python.vscode-pylance'], '1.0.0');
    assert.equal(result.notFound, ['unknown.ext']);
    assert.equal('unknown.ext' in result.versions, false);
  });

  it('returns check_failed on timeout', async () => {
    stubHttpsRequest((_url, _opts, _cb) => {
      return createMockRequest(null, null, null, true);
    });

    const result = await resolveLatest(['some.ext'], { timeoutMs: 100 });
    assert.equal(result.status, 'check_failed');
    assert.ok(result.error.includes('timeout'));
  });

  it('returns check_failed on network error', async () => {
    stubHttpsRequest((_url, _opts, _cb) => {
      const req = createMockRequest(null, null, new Error('ECONNREFUSED'));
      req._simulate(undefined);
      return req;
    });

    const result = await resolveLatest(['some.ext']);
    assert.equal(result.status, 'check_failed');
    assert.equal(result.error, 'ECONNREFUSED');
  });

  it('returns check_failed on HTTP error', async () => {
    stubHttpsRequest((_url, _opts, cb) => {
      const req = createMockRequest(500, 'Internal Server Error');
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['some.ext']);
    assert.equal(result.status, 'check_failed');
  });

  it('returns check_failed on 429 rate limit', async () => {
    stubHttpsRequest((_url, _opts, cb) => {
      const req = createMockRequest(429, 'Too Many Requests');
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['some.ext']);
    assert.equal(result.status, 'check_failed');
    assert.ok(result.error.includes('rate'));
  });

  it('returns check_failed on malformed JSON response', async () => {
    stubHttpsRequest((_url, _opts, cb) => {
      const req = createMockRequest(200, 'not json');
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['some.ext']);
    assert.equal(result.status, 'check_failed');
    assert.ok(result.error.includes('JSON'));
  });

  it('sends correct request body with criteria and flags', async () => {
    let capturedBody = '';
    stubHttpsRequest((_url, opts, cb) => {
      const req = createMockRequest(200, JSON.stringify({
        results: [{ extensions: [] }]
      }));
      // Capture the written body
      const origWrite = req.write.bind(req);
      req.write = function (data) {
        capturedBody = data;
        return origWrite(data);
      };
      req._simulate(cb);
      return req;
    });

    await resolveLatest(['ms-python.vscode-pylance']);
    const parsed = JSON.parse(capturedBody);

    assert.equal(parsed.filters.length, 1);
    assert.ok(parsed.filters[0].criteria.some(c => c.filterType === 12));
    assert.ok(parsed.filters[0].criteria.some(c => c.filterType === 7 && c.value === 'ms-python.vscode-pylance'));
    assert.equal(parsed.flags, 976);
  });

  it('handles empty extension list', async () => {
    const result = await resolveLatest([]);
    assert.equal(result.status, 'ok');
    assert.deepStrictEqual(result.versions, {});
  });

  it('uses default 10000ms timeout when not specified', async () => {
    stubHttpsRequest((_url, opts, cb) => {
      // Verify timeout is set
      assert.ok(opts.timeout >= 10000);
      const req = createMockRequest(200, JSON.stringify({
        results: [{ extensions: [] }]
      }));
      req._simulate(cb);
      return req;
    });

    await resolveLatest(['some.ext']);
  });

  it('handles extensions with missing versions array gracefully', async () => {
    stubHttpsRequest((_url, _opts, cb) => {
      const req = createMockRequest(200, JSON.stringify({
        results: [{
          extensions: [
            { extensionId: 'ext-1', extensionName: 'pylance', publisher: { publisherName: 'ms-python' },
              versions: [{ version: '1.0.0' }] },
            { extensionId: 'ext-2', extensionName: 'broken', publisher: { publisherName: 'test' } }
          ]
        }]
      }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['ms-python.vscode-pylance', 'test.broken']);
    assert.equal(result.status, 'ok');
    assert.equal(result.versions['ms-python.vscode-pylance'], '1.0.0');
    // broken extension should be in notFound since we can't determine its version
    assert.ok(result.notFound.includes('test.broken'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts-mcp/lib/marketplace-resolver.test.js`
Expected: FAIL — `Cannot find module './marketplace-resolver'`

- [ ] **Step 3: Write the implementation**

Create `scripts-mcp/lib/marketplace-resolver.js`:

```js
// =============================================================================
// marketplace-resolver.js -- VS Code Marketplace API client
//
// Sends batch extension version queries to the VS Code Marketplace API.
// Returns latest versions for each queried extension ID.
//
// Zero new dependencies — uses Node.js built-in https module.
// =============================================================================

'use strict';

const https = require('node:https');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10000;
const API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
const BATCH_SIZE = 1000;

// flags: IncludeLatestVersionOnly (8) + ExcludeNonValidated (768) = 776
// Adding IncludeAssetUri (128) + IncludeFiles (64) + IncludeVersionProperties (32) = 976
const DEFAULT_FLAGS = 976;

// ---------------------------------------------------------------------------
// resolveLatest(ids, options)
// ---------------------------------------------------------------------------

/**
 * Query the VS Code Marketplace API for latest versions of given extensions.
 *
 * @param {string[]} ids - Extension IDs in "publisher.name" format
 * @param {{ timeoutMs?: number, includePreRelease?: boolean }} [options]
 * @returns {Promise<{
 *   status: 'ok' | 'check_failed',
 *   versions?: { [id: string]: string },
 *   notFound?: string[],
 *   error?: string
 * }>}
 */
function resolveLatest(ids, options) {
  var opts = options || {};
  var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!Array.isArray(ids) || ids.length === 0) {
    return Promise.resolve({ status: 'ok', versions: {}, notFound: [] });
  }

  return new Promise(function (resolve) {
    // Build request body
    var criteria = [];

    for (var i = 0; i < ids.length; i++) {
      criteria.push({ filterType: 7, value: ids[i] });
    }

    // Target platform: Microsoft.VisualStudio.Code
    criteria.push({ filterType: 12, value: 'Microsoft.VisualStudio.Code' });

    var flags = DEFAULT_FLAGS;
    if (opts.includePreRelease) {
      flags = flags | 16; // IncludePreRelease
    }

    var requestBody = JSON.stringify({
      filters: [{
        criteria: criteria,
        pageCount: 1,
        pageSize: BATCH_SIZE
      }],
      flags: flags
    });

    var reqOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json;api-version=3.0-preview.1',
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: timeoutMs
    };

    var req = https.request(API_URL, reqOptions, function (res) {
      var body = '';

      res.on('data', function (chunk) {
        body += chunk;
      });

      res.on('end', function () {
        if (res.statusCode !== 200) {
          var errMsg = 'HTTP ' + res.statusCode;
          if (res.statusCode === 429) errMsg = 'rate limited (' + errMsg + ')';
          resolve({ status: 'check_failed', error: errMsg });
          return;
        }

        var data;
        try {
          data = JSON.parse(body);
        } catch (e) {
          resolve({ status: 'check_failed', error: 'invalid JSON response' });
          return;
        }

        // Parse response into a map of id -> latest version
        var versions = {};
        var notFound = [];

        // Build a set of requested IDs for O(1) lookup
        var requestedSet = {};
        for (var j = 0; j < ids.length; j++) {
          requestedSet[ids[j]] = true;
        }

        // Mark all as found initially, then remove those we resolve
        var foundSet = {};

        var results = data.results || [];
        for (var r = 0; r < results.length; r++) {
          var extensions = results[r].extensions || [];
          for (var e = 0; e < extensions.length; e++) {
            var ext = extensions[e];
            var publisherName = ext.publisher && ext.publisher.publisherName ? ext.publisher.publisherName : '';
            var extName = ext.extensionName || '';
            var fullId = publisherName + '.' + extName;

            if (!requestedSet[fullId]) continue;

            var extVersions = ext.versions || [];
            if (extVersions.length > 0) {
              versions[fullId] = extVersions[0].version;
              foundSet[fullId] = true;
            } else {
              // Extension found but has no versions
              notFound.push(fullId);
              foundSet[fullId] = true;
            }
          }
        }

        // Any requested ID not found in the response
        for (var k = 0; k < ids.length; k++) {
          if (!foundSet[ids[k]]) {
            notFound.push(ids[k]);
          }
        }

        resolve({ status: 'ok', versions: versions, notFound: notFound });
      });
    });

    req.on('timeout', function () {
      req.destroy();
      resolve({ status: 'check_failed', error: 'timeout' });
    });

    req.on('error', function (err) {
      resolve({ status: 'check_failed', error: err.message });
    });

    req.write(requestBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolveLatest: resolveLatest
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts-mcp/lib/marketplace-resolver.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts-mcp/lib/marketplace-resolver.js scripts-mcp/lib/marketplace-resolver.test.js
git commit -m "feat: add marketplace-resolver for VS Code Marketplace API queries"
```

---

### Task 2: cursor-extensions.js — Cursor Extension Tool Module

**Files:**
- Create: `scripts-mcp/lib/tools/cursor-extensions.js`
- Test: `scripts-mcp/lib/tools/cursor-extensions.test.js`

Follows the same pattern as `cursor.js` (MCP tool) but reads `extensions.json` and exports `parseExtensions` instead of `parseMcpServers`.

- [ ] **Step 1: Write the failing tests**

Create `scripts-mcp/lib/tools/cursor-extensions.test.js`:

```js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// --- Helpers ---

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-ext-test-'));

function tmpDir(name) {
  const dir = path.join(TMPDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRaw(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

function cleanup() {
  fs.rmSync(TMPDIR, { recursive: true, force: true });
}

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

function freshModule() {
  delete require.cache[require.resolve('./cursor-extensions.js')];
  return require('./cursor-extensions.js');
}

// --- Sample extensions.json data ---

// Returns the parsed array directly (matching how configIo.readConfig returns parsed data)
function makeExtensionsJson(extensions) {
  return extensions;
}

function makeGalleryEntry(id, version, pinned) {
  return {
    identifier: { id: id, uuid: '00000000-0000-0000-0000-000000000000' },
    version: version,
    location: { path: '/fake/' + id + '-' + version },
    metadata: { installedTimestamp: 1, pinned: !!pinned, source: 'gallery', id: '00000000-0000-0000-0000-000000000000' }
  };
}

function makeVsixEntry(id, version) {
  return {
    identifier: { id: id, uuid: '11111111-1111-1111-1111-111111111111' },
    version: version,
    location: { path: '/fake/' + id + '-' + version },
    metadata: { installedTimestamp: 1, pinned: false, source: 'vsix', id: '11111111-1111-1111-1111-111111111111' }
  };
}

function makeNoSourceEntry(id, version) {
  return {
    identifier: { id: id, uuid: '22222222-2222-2222-2222-222222222222' },
    version: version,
    location: { path: '/fake/' + id + '-' + version },
    metadata: { installedTimestamp: 1, pinned: false }
  };
}

// --- discover() tests ---

describe('cursor-extensions discover()', () => {
  beforeEach(() => { restoreHomedir(); });
  afterEach(() => { restoreHomedir(); });

  it('returns configPath when ~/.cursor/extensions/extensions.json exists', () => {
    const home = tmpDir('home-exists');
    const extDir = path.join(home, '.cursor', 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    writeRaw(path.join(extDir, 'extensions.json'), '[]');

    stubHomedir(home);
    const mod = freshModule();
    const result = mod.discover();

    assert.ok(result !== null);
    assert.equal(result, path.join(home, '.cursor', 'extensions', 'extensions.json'));
  });

  it('returns null when ~/.cursor/extensions/extensions.json does not exist', () => {
    const home = tmpDir('home-missing');

    stubHomedir(home);
    const mod = freshModule();
    const result = mod.discover();

    assert.equal(result, null);
  });

  it('returns null when ~/.cursor/extensions/ directory does not exist', () => {
    const home = tmpDir('home-nodir');

    stubHomedir(home);
    const mod = freshModule();
    const result = mod.discover();

    assert.equal(result, null);
  });
});

// --- parseExtensions() tests ---

describe('cursor-extensions parseExtensions()', () => {
  it('extracts gallery-sourced extensions', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('ms-python.vscode-pylance', '2024.8.1', false),
      makeGalleryEntry('geddski.macros', '1.2.1', true)
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 2);
    assert.equal(result.extensions[0].key, 'ms-python.vscode-pylance');
    assert.equal(result.extensions[0].id, 'ms-python.vscode-pylance');
    assert.equal(result.extensions[0].version, '2024.8.1');
    assert.equal(result.extensions[0].pinned, false);
    assert.equal(result.extensions[1].key, 'geddski.macros');
    assert.equal(result.extensions[1].pinned, true);
    assert.equal(result.skippedNonGallery, 0);
  });

  it('excludes vsix-sourced extensions', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('ms-python.pylance', '1.0.0', false),
      makeVsixEntry('some.vsix-ext', '2.0.0')
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].id, 'ms-python.pylance');
    assert.equal(result.skippedNonGallery, 1);
  });

  it('excludes extensions with undefined source', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('gallery.ext', '1.0.0', false),
      makeNoSourceEntry('nosource.ext', '2.0.0')
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].id, 'gallery.ext');
    assert.equal(result.skippedNonGallery, 1);
  });

  it('returns empty array for empty extensions.json', () => {
    const mod = freshModule();
    const result = mod.parseExtensions('/fake/path', []);

    assert.ok(Array.isArray(result.extensions));
    assert.equal(result.extensions.length, 0);
    assert.equal(result.skippedNonGallery, 0);
  });

  it('handles entries with missing identifier or version gracefully', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('valid.ext', '1.0.0', false),
      { metadata: { source: 'gallery' } }, // missing identifier and version
      { identifier: { id: 'no-version' }, version: '1.0.0', metadata: { source: 'gallery' } } // no uuid, but valid
    ]);

    const result = mod.parseExtensions('/fake/path', rawJson);

    // Should include valid entries, skip malformed
    assert.ok(result.extensions.length >= 2);
    assert.ok(result.extensions.some(e => e.id === 'valid.ext'));
    assert.ok(result.extensions.some(e => e.id === 'no-version'));
  });

  it('handles non-array rawJson gracefully', () => {
    const mod = freshModule();
    const result = mod.parseExtensions('/fake/path', { not: 'an array' });

    assert.ok(Array.isArray(result.extensions));
    assert.equal(result.extensions.length, 0);
    assert.equal(result.skippedNonGallery, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts-mcp/lib/tools/cursor-extensions.test.js`
Expected: FAIL — `Cannot find module './cursor-extensions.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts-mcp/lib/tools/cursor-extensions.js`:

```js
// =============================================================================
// cursor-extensions.js -- Cursor extension.json handler
//
// Reads ~/.cursor/extensions/extensions.json and extracts gallery-sourced
// extension entries for version checking.
//
// Tool module interface: { name, discover(), parseExtensions() }
// =============================================================================

'use strict';

var fs = require('node:fs');
var path = require('node:path');
var os = require('node:os');

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

function discover() {
  var configPath = path.join(os.homedir(), '.cursor', 'extensions', 'extensions.json');
  return fs.existsSync(configPath) ? configPath : null;
}

// ---------------------------------------------------------------------------
// parseExtensions()
// ---------------------------------------------------------------------------

function parseExtensions(configPath, rawJson) {
  if (!Array.isArray(rawJson)) {
    return { extensions: [], skippedNonGallery: 0 };
  }

  var results = [];
  var skippedNonGallery = 0;

  for (var i = 0; i < rawJson.length; i++) {
    var entry = rawJson[i];

    // Must have identifier with id
    if (!entry || !entry.identifier || !entry.identifier.id) {
      continue;
    }

    // Must have a version
    if (typeof entry.version !== 'string') {
      continue;
    }

    // Must be gallery-sourced
    var source = entry.metadata && entry.metadata.source;
    if (source !== 'gallery') {
      skippedNonGallery++;
      continue;
    }

    results.push({
      key: entry.identifier.id,
      id: entry.identifier.id,
      version: entry.version,
      pinned: !!(entry.metadata && entry.metadata.pinned)
    });
  }

  return { extensions: results, skippedNonGallery: skippedNonGallery };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  name: 'cursor-extensions',
  discover: discover,
  parseExtensions: parseExtensions
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts-mcp/lib/tools/cursor-extensions.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts-mcp/lib/tools/cursor-extensions.js scripts-mcp/lib/tools/cursor-extensions.test.js
git commit -m "feat: add cursor-extensions tool module for extension.json parsing"
```

---

### Task 3: windsurf-extensions.js — Windsurf Extension Tool Module

**Files:**
- Create: `scripts-mcp/lib/tools/windsurf-extensions.js`
- Test: `scripts-mcp/lib/tools/windsurf-extensions.test.js`

Nearly identical to `cursor-extensions.js`, differing only in the config path (`~/.windsurf/extensions/extensions.json`) and the module name.

- [ ] **Step 1: Write the failing tests**

Create `scripts-mcp/lib/tools/windsurf-extensions.test.js`:

```js
'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// --- Helpers ---

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'windsurf-ext-test-'));

function tmpDir(name) {
  const dir = path.join(TMPDIR, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRaw(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
}

const realHomedir = os.homedir;

function stubHomedir(tmpDir) {
  os.homedir = () => tmpDir;
}

function restoreHomedir() {
  os.homedir = realHomedir;
}

function freshModule() {
  delete require.cache[require.resolve('./windsurf-extensions.js')];
  return require('./windsurf-extensions.js');
}

function makeGalleryEntry(id, version) {
  return {
    identifier: { id: id, uuid: '00000000-0000-0000-0000-000000000000' },
    version: version,
    location: { path: '/fake/' + id + '-' + version },
    metadata: { installedTimestamp: 1, pinned: false, source: 'gallery', id: '00000000-0000-0000-0000-000000000000' }
  };
}

// --- discover() tests ---

describe('windsurf-extensions discover()', () => {
  beforeEach(() => { restoreHomedir(); });
  afterEach(() => { restoreHomedir(); });

  it('returns configPath when ~/.windsurf/extensions/extensions.json exists', () => {
    const home = tmpDir('home-exists');
    const extDir = path.join(home, '.windsurf', 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    writeRaw(path.join(extDir, 'extensions.json'), '[]');

    stubHomedir(home);
    const mod = freshModule();
    const result = mod.discover();

    assert.ok(result !== null);
    assert.equal(result, path.join(home, '.windsurf', 'extensions', 'extensions.json'));
  });

  it('returns null when ~/.windsurf/extensions/extensions.json does not exist', () => {
    const home = tmpDir('home-missing');

    stubHomedir(home);
    const mod = freshModule();
    const result = mod.discover();

    assert.equal(result, null);
  });
});

// --- parseExtensions() tests ---

describe('windsurf-extensions parseExtensions()', () => {
  it('extracts gallery-sourced extensions', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('ms-azuretools.vscode-docker', '2.0.0'),
      makeGalleryEntry('username.my-ext', '1.5.0')
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 2);
    assert.equal(result.extensions[0].id, 'ms-azuretools.vscode-docker');
    assert.equal(result.extensions[0].version, '2.0.0');
    assert.equal(result.extensions[1].id, 'username.my-ext');
  });

  it('excludes non-gallery extensions and tracks skipped count', () => {
    const mod = freshModule();
    const rawJson = [
      makeGalleryEntry('gallery.ext', '1.0.0'),
      {
        identifier: { id: 'vsix.ext', uuid: '111' },
        version: '2.0.0',
        metadata: { source: 'vsix' }
      }
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].id, 'gallery.ext');
    assert.equal(result.skippedNonGallery, 1);
  });

  it('exports correct name', () => {
    const mod = freshModule();
    assert.equal(mod.name, 'windsurf-extensions');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts-mcp/lib/tools/windsurf-extensions.test.js`
Expected: FAIL — `Cannot find module './windsurf-extensions.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts-mcp/lib/tools/windsurf-extensions.js`. This is identical to `cursor-extensions.js` except for the path and name:

```js
// =============================================================================
// windsurf-extensions.js -- Windsurf extension.json handler
//
// Reads ~/.windsurf/extensions/extensions.json and extracts gallery-sourced
// extension entries for version checking.
//
// Tool module interface: { name, discover(), parseExtensions() }
// =============================================================================

'use strict';

var fs = require('node:fs');
var path = require('node:path');
var os = require('node:os');

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

function discover() {
  var configPath = path.join(os.homedir(), '.windsurf', 'extensions', 'extensions.json');
  return fs.existsSync(configPath) ? configPath : null;
}

// ---------------------------------------------------------------------------
// parseExtensions()
// ---------------------------------------------------------------------------

function parseExtensions(configPath, rawJson) {
  if (!Array.isArray(rawJson)) {
    return { extensions: [], skippedNonGallery: 0 };
  }

  var results = [];
  var skippedNonGallery = 0;

  for (var i = 0; i < rawJson.length; i++) {
    var entry = rawJson[i];

    if (!entry || !entry.identifier || !entry.identifier.id) {
      continue;
    }

    if (typeof entry.version !== 'string') {
      continue;
    }

    var source = entry.metadata && entry.metadata.source;
    if (source !== 'gallery') {
      skippedNonGallery++;
      continue;
    }

    results.push({
      key: entry.identifier.id,
      id: entry.identifier.id,
      version: entry.version,
      pinned: !!(entry.metadata && entry.metadata.pinned)
    });
  }

  return { extensions: results, skippedNonGallery: skippedNonGallery };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  name: 'windsurf-extensions',
  discover: discover,
  parseExtensions: parseExtensions
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts-mcp/lib/tools/windsurf-extensions.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts-mcp/lib/tools/windsurf-extensions.js scripts-mcp/lib/tools/windsurf-extensions.test.js
git commit -m "feat: add windsurf-extensions tool module for extension.json parsing"
```

---

## Chunk 2: CLI Entry Point + Slash Command + Integration

### Task 4: update-extensions.js — CLI Entry Point

**Files:**
- Create: `scripts-mcp/update-extensions.js`
- Test: `scripts-mcp/update-extensions.test.js`

The CLI entry point. Follows the same pattern as `update-mcp.js`: `parseArgs`, `processTool`, `main`. Orchestrates discovery → parsing → Marketplace query → comparison → reporting.

Key differences from `update-mcp.js`:
- Filters discovered tools by `parseExtensions` duck-typing
- Calls `marketplaceResolver.resolveLatest` (batch) instead of per-server `npmResolver.resolveLatest`
- Check-only — no write path
- Different CLI flags (`--include-prerelease` instead of `--dry-run`/`--check`/`--force`)
- Result schema aligned to reporter.js (`servers` array with `package`/`current`/`latest`)

- [ ] **Step 1: Write the failing tests**

Create `scripts-mcp/update-extensions.test.js`:

```js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./update-extensions.js');

// ---------------------------------------------------------------------------
// parseArgs: default (no flags)
// ---------------------------------------------------------------------------

test('parseArgs: no flags returns defaults', function () {
  var result = parseArgs([]);
  assert.equal(result.toolName, null);
  assert.equal(result.json, false);
  assert.equal(result.includePreRelease, false);
});

// ---------------------------------------------------------------------------
// parseArgs: individual flags
// ---------------------------------------------------------------------------

test('parseArgs: --json', function () {
  assert.equal(parseArgs(['--json']).json, true);
});

test('parseArgs: --include-prerelease', function () {
  assert.equal(parseArgs(['--include-prerelease']).includePreRelease, true);
});

test('parseArgs: --tool NAME', function () {
  var result = parseArgs(['--tool', 'cursor-extensions']);
  assert.equal(result.toolName, 'cursor-extensions');
});

// ---------------------------------------------------------------------------
// parseArgs: flag combinations
// ---------------------------------------------------------------------------

test('parseArgs: multiple flags combined', function () {
  var result = parseArgs(['--json', '--tool', 'windsurf-extensions', '--include-prerelease']);
  assert.equal(result.json, true);
  assert.equal(result.toolName, 'windsurf-extensions');
  assert.equal(result.includePreRelease, true);
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
  var result = parseArgs(['--tool', '--json']);
  assert.ok(result.error, 'should have error');
});

test('parseArgs: unknown flag returns error', function () {
  var result = parseArgs(['--bogus']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('Unknown flag'), 'should mention unknown flag');
});

test('parseArgs: positional arg returns error', function () {
  var result = parseArgs(['something']);
  assert.ok(result.error, 'should have error for positional arg');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts-mcp/update-extensions.test.js`
Expected: FAIL — `Cannot find module './update-extensions.js'`

- [ ] **Step 3: Write the implementation**

Create `scripts-mcp/update-extensions.js`:

```js
#!/usr/bin/env node
// =============================================================================
// update-extensions.js -- Entry point and CLI parser for extension update checks
//
// Discovers VS Code fork editors (Cursor, Windsurf), reads their extensions.json,
// queries the VS Code Marketplace API for latest versions, and reports which
// extensions are outdated.
//
// Usage: node update-extensions.js [--tool NAME] [--json] [--include-prerelease]
//
// Exit codes:
//   0 - All checks successful
//   1 - Partial failure (some extensions failed to check)
//   2 - Total error (bad args, no tools found, --tool NAME not found)
// =============================================================================

'use strict';

var registry = require('./lib/registry.js');
var configIo = require('./lib/config-io.js');
var marketplaceResolver = require('./lib/marketplace-resolver.js');
var reporter = require('./lib/reporter.js');

// ---------------------------------------------------------------------------
// Parse CLI arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  var opts = {
    toolName: null,
    json: false,
    includePreRelease: false
  };

  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    switch (arg) {
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
      case '--include-prerelease':
        opts.includePreRelease = true;
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

async function processTool(discoveredTool, opts) {
  var tool = discoveredTool.tool;
  var configPath = discoveredTool.configPath;
  var toolResult = {
    status: 'ok',
    configPath: configPath,
    servers: [],
    skippedNonGallery: 0
  };

  // -- Read config
  var readResult = configIo.readConfig(configPath);
  if (!readResult.ok) {
    toolResult.status = 'parse_error';
    toolResult.error = readResult.error;
    return toolResult;
  }

  var rawJson = readResult.data;

  // -- Parse extensions
  var parsed;
  try {
    parsed = tool.parseExtensions(configPath, rawJson);
  } catch (e) {
    toolResult.status = 'parse_error';
    toolResult.error = 'failed to parse extensions: ' + e.message;
    return toolResult;
  }

  var extensions = parsed.extensions || [];
  toolResult.skippedNonGallery = parsed.skippedNonGallery || 0;

  // -- Nothing to check
  if (extensions.length === 0) {
    return toolResult;
  }

  // -- Query Marketplace API (batch)
  var ids = extensions.map(function (ext) { return ext.id; });
  var resolveResult = await marketplaceResolver.resolveLatest(ids, {
    includePreRelease: opts.includePreRelease
  });

  if (resolveResult.status !== 'ok') {
    // API failure — mark all extensions as check_failed
    toolResult.status = 'api_error';
    toolResult.apiError = resolveResult.error;
    for (var i = 0; i < extensions.length; i++) {
      toolResult.servers.push({
        key: extensions[i].id,
        package: extensions[i].id,
        current: extensions[i].version,
        status: 'check_failed',
        error: resolveResult.error
      });
    }
    return toolResult;
  }

  // -- Compare installed vs latest
  var versions = resolveResult.versions || {};
  var notFound = resolveResult.notFound || [];

  for (var j = 0; j < extensions.length; j++) {
    var ext = extensions[j];
    var serverResult = {
      key: ext.id,
      package: ext.id,
      current: ext.version
    };

    if (notFound.indexOf(ext.id) !== -1) {
      serverResult.status = 'not_found';
    } else if (versions[ext.id]) {
      serverResult.latest = versions[ext.id];
      if (ext.version === versions[ext.id]) {
        serverResult.status = 'current';
      } else {
        serverResult.status = 'updated';
      }
    } else {
      // Not in notFound but also not in versions — shouldn't happen,
      // but treat as not_found
      serverResult.status = 'not_found';
    }

    toolResult.servers.push(serverResult);
  }

  return toolResult;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  var parsed = parseArgs(argv);

  if (parsed.help) {
    console.log([
      '',
      'update-extensions.js -- Check extension updates for Cursor and Windsurf',
      '',
      'Usage: node update-extensions.js [flags]',
      '  --tool NAME           Only process named tool',
      '  --json                Output as JSON',
      '  --include-prerelease  Consider pre-release versions',
      '  --help                Show this help message',
      ''
    ].join('\n'));
    process.exit(0);
  }

  if (parsed.error) {
    console.error(parsed.error);
    process.exit(2);
  }

  // -- Discover ALL tools via registry, then filter to extension tools only
  var allDiscovered = registry.discover();
  var extensionTools = allDiscovered.filter(function (t) {
    return typeof t.tool.parseExtensions === 'function';
  });

  // -- Validate --tool NAME against extension tools
  if (parsed.toolName) {
    var found = extensionTools.some(function (t) { return t.name === parsed.toolName; });
    if (!found) {
      console.error("Tool '" + parsed.toolName + "' not found.");
      var names = extensionTools.map(function (t) { return t.name; });
      if (names.length > 0) {
        console.error('Available extension tools: ' + names.join(', '));
      }
      process.exit(2);
    }
  }

  // -- Filter to requested tool
  if (parsed.toolName) {
    extensionTools = extensionTools.filter(function (t) { return t.name === parsed.toolName; });
  }

  if (extensionTools.length === 0) {
    if (parsed.toolName) {
      console.error("Tool '" + parsed.toolName + "' is known but its config file was not found.");
    } else {
      console.error('No extension config files found for any supported tools.');
      console.error('Supported extension tools: cursor-extensions, windsurf-extensions');
    }
    process.exit(2);
  }

  // -- Process each tool
  var results = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  var hasFailures = false;

  for (var i = 0; i < extensionTools.length; i++) {
    var toolName = extensionTools[i].name;
    var toolResult = await processTool(extensionTools[i], parsed);
    results.tools[toolName] = toolResult;

    toolResult.servers.forEach(function (s) {
      switch (s.status) {
        case 'updated':
          results.summary.updated++;
          break;
        case 'current':
          results.summary.current++;
          break;
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
    console.log(reporter.formatText(results, extensionTools.length));
  }

  // -- Exit code
  if (hasFailures) {
    process.exit(1);
  }

  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(function (err) {
    console.error('Fatal error:', err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs: parseArgs, main: main, processTool: processTool };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts-mcp/update-extensions.test.js`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add scripts-mcp/update-extensions.js scripts-mcp/update-extensions.test.js
git commit -m "feat: add update-extensions CLI entry point for extension update checking"
```

---

### Task 5: Slash Command + package.json Integration

**Files:**
- Create: `commands/update-extensions.md`
- Modify: `package.json` (test script)

- [ ] **Step 1: Create the slash command**

Create `commands/update-extensions.md`:

```markdown
---
description: Check for extension updates across Cursor and Windsurf
argument-hint: [--tool NAME] [--json] [--include-prerelease]
allowed-tools: Bash
---

Check extension versions against the VS Code Marketplace API for Cursor and Windsurf extensions.

```bash
find ~/.claude/plugins/cache -path "*/cc-update-all/update-all-plugins/*/scripts-mcp/update-extensions.js" 2>/dev/null | head -1 | xargs -I{} node {} $ARGUMENTS
```

Present the summary output to the user. If any extensions are outdated, note that the editors have no CLI for auto-installation — updates must be applied manually through the editor's extension panel.
```

- [ ] **Step 2: Update package.json test script**

Add the new test files to the `test` script in `package.json`. The current test script is:

```
"test": "node --test scripts-mcp/lib/npm-resolver.test.js scripts-mcp/lib/config-io.test.js scripts-mcp/lib/tools/cursor.test.js scripts-mcp/lib/tools/cline.test.js scripts-mcp/lib/tools/roo-code.test.js scripts-mcp/lib/registry.test.js scripts-mcp/lib/reporter.test.js scripts-mcp/update-mcp.test.js"
```

Append the new test files:

```
"test": "node --test scripts-mcp/lib/npm-resolver.test.js scripts-mcp/lib/config-io.test.js scripts-mcp/lib/tools/cursor.test.js scripts-mcp/lib/tools/cline.test.js scripts-mcp/lib/tools/roo-code.test.js scripts-mcp/lib/registry.test.js scripts-mcp/lib/reporter.test.js scripts-mcp/lib/marketplace-resolver.test.js scripts-mcp/lib/tools/cursor-extensions.test.js scripts-mcp/lib/tools/windsurf-extensions.test.js scripts-mcp/update-mcp.test.js scripts-mcp/update-extensions.test.js"
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests PASS (both existing MCP tests and new extension tests)

- [ ] **Step 4: Commit**

```bash
git add commands/update-extensions.md package.json
git commit -m "feat: add /update-extensions slash command and update test script"
```
