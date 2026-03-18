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
  https.request = (urlOrOpts, optsOrCb, maybeCb) => {
    const url = typeof urlOrOpts === 'string' ? urlOrOpts : urlOrOpts?.href || '';
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
        setTimeout(() => {
          if (timeoutHandler) timeoutHandler();
        }, 20);
      }
      return this;
    },
    on(event, handler) {
      if (event === 'timeout') timeoutHandler = handler;
      else if (event === 'error') errorHandler = handler;
      return this;
    },
    write() {
      return this;
    },
    end() {
      return this;
    },
    abort() {
      return this;
    },
  };

  req._simulate = (responseCallback) => {
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
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [
            {
              extensions: [
                {
                  extensionId: 'ext-1',
                  extensionName: 'vscode-pylance',
                  publisher: { publisherName: 'ms-python' },
                  versions: [{ version: '2026.1.101' }],
                },
                {
                  extensionId: 'ext-2',
                  extensionName: 'macros',
                  publisher: { publisherName: 'geddski' },
                  versions: [{ version: '2.0.0' }],
                },
              ],
            },
          ],
        }),
      );
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
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [
            {
              extensions: [
                {
                  extensionId: 'ext-1',
                  extensionName: 'vscode-pylance',
                  publisher: { publisherName: 'ms-python' },
                  versions: [{ version: '1.0.0' }],
                },
              ],
            },
          ],
        }),
      );
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
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [
            {
              extensions: [
                {
                  extensionId: 'ext-1',
                  extensionName: 'vscode-pylance',
                  publisher: { publisherName: 'ms-python' },
                  versions: [{ version: '1.0.0' }],
                },
              ],
            },
          ],
        }),
      );
      req._simulate(cb);
      return req;
    });

    const result = await resolveLatest(['ms-python.vscode-pylance', 'unknown.ext']);
    assert.equal(result.status, 'ok');
    assert.equal(result.versions['ms-python.vscode-pylance'], '1.0.0');
    assert.deepStrictEqual(result.notFound, ['unknown.ext']);
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
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [{ extensions: [] }],
        }),
      );
      // Capture the written body
      const origWrite = req.write.bind(req);
      req.write = (data) => {
        capturedBody = data;
        return origWrite(data);
      };
      req._simulate(cb);
      return req;
    });

    await resolveLatest(['ms-python.vscode-pylance']);
    const parsed = JSON.parse(capturedBody);

    assert.equal(parsed.filters.length, 1);
    assert.ok(parsed.filters[0].criteria.some((c) => c.filterType === 12));
    assert.ok(parsed.filters[0].criteria.some((c) => c.filterType === 7 && c.value === 'ms-python.vscode-pylance'));
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
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [{ extensions: [] }],
        }),
      );
      req._simulate(cb);
      return req;
    });

    await resolveLatest(['some.ext']);
  });

  it('handles extensions with missing versions array gracefully', async () => {
    stubHttpsRequest((_url, _opts, cb) => {
      const req = createMockRequest(
        200,
        JSON.stringify({
          results: [
            {
              extensions: [
                {
                  extensionId: 'ext-1',
                  extensionName: 'vscode-pylance',
                  publisher: { publisherName: 'ms-python' },
                  versions: [{ version: '1.0.0' }],
                },
                { extensionId: 'ext-2', extensionName: 'broken', publisher: { publisherName: 'test' } },
              ],
            },
          ],
        }),
      );
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
