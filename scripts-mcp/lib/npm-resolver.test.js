const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');

// -------------------------------------------------------
// Stubs / helpers
// -------------------------------------------------------

let _originalGet;
let _mockFactory;

/**
 * Intercept https.get so resolveLatest hits our fake server
 * instead of the real npm registry.
 *
 * @param {function} factory - (url, callback) => returns a mock request object
 *   The callback is the response callback passed to https.get.
 *   The factory MUST call it with a mock response to simulate a server reply,
 *   or not call it (and instead trigger timeout/error on the mock request)
 *   to simulate failures.
 */
function stubHttpsGet(factory) {
  _mockFactory = factory;
  https.get = (urlOrOpts, optsOrCb, maybeCb) => {
    const url = typeof urlOrOpts === 'string' ? urlOrOpts : urlOrOpts.href;
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const opts = typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb : {};
    const req = _mockFactory(url, cb);
    // Simulate Node.js https.get setting timeout from options
    if (opts.timeout != null && typeof req.setTimeout === 'function') {
      req.setTimeout(opts.timeout);
    }
    return req;
  };
}

function restoreHttpsGet() {
  https.get = _originalGet;
}

/**
 * Create a mock HTTPS request/response pair.
 *
 * When end() is called, the mock will:
 * - On success (statusCode provided): call responseCallback with a mock response
 * - On error: emit 'error' event with the given error
 * - On timeout: emit 'timeout' event after 20ms
 *
 * @param {number|null} statusCode - HTTP status code
 * @param {string} body - Response body
 * @param {Error|null} [error=null] - Error to emit
 * @param {boolean} [simulateTimeout=false] - Simulate a timeout
 */
function createMockRequest(statusCode, body, error = null, simulateTimeout = false) {
  let timeoutHandler = null;
  let errorHandler = null;

  const req = {
    destroy() {
      /* no-op */
    },

    setTimeout(_ms) {
      if (simulateTimeout) {
        setTimeout(() => {
          if (timeoutHandler) timeoutHandler();
        }, 20);
      }
      return this;
    },

    on(event, handler) {
      if (event === 'timeout') {
        timeoutHandler = handler;
      } else if (event === 'error') {
        errorHandler = handler;
      }
      return this;
    },

    /**
     * end() returns the mock response via the callback.
     * The callback is NOT stored here -- it's provided by the factory.
     * Instead, the factory wraps createMockRequest and passes the callback
     * to end(), or stores it on the request for end() to use.
     */
    end() {
      return this;
    },
  };

  // Attach end behavior externally via _simulate method
  // This is called by the factory with the response callback
  req._simulate = (responseCallback) => {
    setImmediate(() => {
      if (error && !simulateTimeout) {
        if (errorHandler) errorHandler(error);
        return;
      }

      if (simulateTimeout) {
        // Timeout is handled by setTimeout in setTimeout() above
        return;
      }

      const res = {
        statusCode,
        on(event, handler) {
          if (event === 'data' && body) {
            setImmediate(() => handler(body));
          }
          if (event === 'end') {
            setImmediate(() => handler());
          }
          return this;
        },
      };

      if (responseCallback && statusCode !== null) {
        responseCallback(res);
      }
    });
  };

  return req;
}

// -------------------------------------------------------
// extractPinnedVersion
// -------------------------------------------------------

describe('extractPinnedVersion', () => {
  let extractPinnedVersion;

  beforeEach(() => {
    delete require.cache[require.resolve('./npm-resolver')];
    ({ extractPinnedVersion } = require('./npm-resolver'));
  });

  // --- pinned versions ---

  it('extracts scoped package with pinned version', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name@1.2.3']);
    assert.equal(result.pkg, '@pkg/name');
    assert.equal(result.pinned, '1.2.3');
  });

  it('extracts unscoped package with pinned version', () => {
    const result = extractPinnedVersion(['-y', 'my-pkg@3.0.1']);
    assert.equal(result.pkg, 'my-pkg');
    assert.equal(result.pinned, '3.0.1');
  });

  it('extracts scoped package with semver range pinned (e.g. 1.2.x)', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name@1.2.x']);
    assert.equal(result.pkg, '@pkg/name');
    assert.equal(result.pinned, '1.2.x');
  });

  // --- subpath extraction ---

  it('extracts base package and version, discarding subpath', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name@1.2.3/sub/path']);
    assert.equal(result.pkg, '@pkg/name');
    assert.equal(result.pinned, '1.2.3');
  });

  // --- floating / no version ---

  it('returns skipped_floating when no version is present', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name']);
    assert.equal(result.status, 'skipped_floating');
  });

  it('returns skipped_floating when @latest is used', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name@latest']);
    assert.equal(result.status, 'skipped_floating');
  });

  it('returns skipped_floating when @next is used', () => {
    const result = extractPinnedVersion(['-y', '@pkg/name@next']);
    assert.equal(result.status, 'skipped_floating');
  });

  it('returns skipped_floating for unscoped package with no version', () => {
    const result = extractPinnedVersion(['-y', 'my-pkg']);
    assert.equal(result.status, 'skipped_floating');
  });

  // --- git URLs (not_npm) ---

  it('returns not_npm for github: prefix', () => {
    const result = extractPinnedVersion(['-y', 'github:user/repo']);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for git+ prefix', () => {
    const result = extractPinnedVersion(['-y', 'git+https://github.com/user/repo.git']);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for https:// prefix', () => {
    const result = extractPinnedVersion(['-y', 'https://github.com/user/repo.git']);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for http:// prefix', () => {
    const result = extractPinnedVersion(['-y', 'http://example.com/pkg.tar.gz']);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for git:// prefix', () => {
    const result = extractPinnedVersion(['-y', 'git://github.com/user/repo.git']);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for git@ prefix', () => {
    const result = extractPinnedVersion(['-y', 'git@github.com:user/repo.git']);
    assert.equal(result.status, 'not_npm');
  });

  // --- edge cases ---

  it('returns not_npm for empty args array', () => {
    const result = extractPinnedVersion([]);
    assert.equal(result.status, 'not_npm');
  });

  it('returns not_npm for args with no package specifier', () => {
    const result = extractPinnedVersion(['-y']);
    assert.equal(result.status, 'not_npm');
  });

  it('handles args without -y flag (still finds package arg)', () => {
    const result = extractPinnedVersion(['@pkg/name@1.0.0']);
    assert.equal(result.pkg, '@pkg/name');
    assert.equal(result.pinned, '1.0.0');
  });

  it('finds the package argument among other args', () => {
    const result = extractPinnedVersion(['--yes', '@pkg/name@2.0.0', '--some-flag']);
    assert.equal(result.pkg, '@pkg/name');
    assert.equal(result.pinned, '2.0.0');
  });
});

// -------------------------------------------------------
// resolveLatest
// -------------------------------------------------------

describe('resolveLatest', () => {
  let resolveLatest;

  beforeEach(() => {
    delete require.cache[require.resolve('./npm-resolver')];
    _originalGet = https.get;
    ({ resolveLatest } = require('./npm-resolver'));
  });

  afterEach(() => {
    restoreHttpsGet();
  });

  it('returns latest version on successful registry response', async () => {
    stubHttpsGet((url, cb) => {
      assert.ok(url.includes('registry.npmjs.org'));
      assert.ok(url.includes('/my-pkg/latest'));
      const req = createMockRequest(200, JSON.stringify({ version: '2.0.0' }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('my-pkg');
    assert.equal(result.status, 'ok');
    assert.equal(result.latest, '2.0.0');
    assert.equal(result.pkg, 'my-pkg');
  });

  it('returns latest version for scoped package', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(200, JSON.stringify({ version: '3.1.0' }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('@scope/pkg');
    assert.equal(result.status, 'ok');
    assert.equal(result.latest, '3.1.0');
  });

  it('returns check_failed with timeout on timeout', async () => {
    stubHttpsGet((_url, _cb) => {
      return createMockRequest(null, null, null, true);
    });

    const result = await resolveLatest('slow-pkg', 100);
    assert.equal(result.status, 'check_failed');
    assert.equal(result.error, 'timeout');
  });

  it('returns not_found on 404', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(404, JSON.stringify({ error: 'Not found' }));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('nonexistent-pkg');
    assert.equal(result.status, 'not_found');
  });

  it('returns check_failed with rate_limited on 429', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(429, '');
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('some-pkg');
    assert.equal(result.status, 'check_failed');
    assert.equal(result.error, 'rate_limited');
  });

  it('returns check_failed with message on other HTTP errors', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(500, 'Internal Server Error');
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('some-pkg');
    assert.equal(result.status, 'check_failed');
    assert.equal(result.error, 'HTTP 500');
  });

  it('returns check_failed on network error', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(null, null, new Error('ECONNREFUSED'));
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest('some-pkg');
    assert.equal(result.status, 'check_failed');
    assert.equal(result.error, 'ECONNREFUSED');
  });

  it('uses default 5000ms timeout when not specified', async () => {
    stubHttpsGet((_url, cb) => {
      const req = createMockRequest(200, JSON.stringify({ version: '1.0.0' }));
      req._simulate(cb);
      return req;
    });

    const start = Date.now();
    const result = await resolveLatest('timed-pkg');
    const elapsed = Date.now() - start;
    assert.equal(result.status, 'ok');
    assert.equal(result.latest, '1.0.0');
    // Should complete quickly since mock fires immediately
    assert.ok(elapsed < 2000);
  });
});
