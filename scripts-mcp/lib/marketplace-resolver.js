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
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!Array.isArray(ids) || ids.length === 0) {
    return Promise.resolve({ status: 'ok', versions: {}, notFound: [] });
  }

  return new Promise((resolve) => {
    // Build request body
    const criteria = [];

    for (let i = 0; i < ids.length; i++) {
      criteria.push({ filterType: 7, value: ids[i] });
    }

    // Target platform: Microsoft.VisualStudio.Code
    criteria.push({ filterType: 12, value: 'Microsoft.VisualStudio.Code' });

    let flags = DEFAULT_FLAGS;
    if (opts.includePreRelease) {
      flags = flags | 16; // IncludePreRelease
    }

    const requestBody = JSON.stringify({
      filters: [
        {
          criteria: criteria,
          pageCount: 1,
          pageSize: BATCH_SIZE,
        },
      ],
      flags: flags,
    });

    const reqOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json;api-version=3.0-preview.1',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      timeout: timeoutMs,
    };

    const req = https.request(API_URL, reqOptions, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          let errMsg = `HTTP ${res.statusCode}`;
          if (res.statusCode === 429) errMsg = `rate limited (${errMsg})`;
          resolve({ status: 'check_failed', error: errMsg });
          return;
        }

        let data;
        try {
          data = JSON.parse(body);
        } catch (e) {
          resolve({ status: 'check_failed', error: 'invalid JSON response' });
          return;
        }

        // Parse response into a map of id -> latest version
        const versions = {};
        const notFound = [];

        // Build a set of requested IDs for O(1) lookup
        const requestedSet = {};
        for (let j = 0; j < ids.length; j++) {
          requestedSet[ids[j]] = true;
        }

        // Mark all as found initially, then remove those we resolve
        const foundSet = {};

        const results = data.results || [];
        for (let r = 0; r < results.length; r++) {
          const extensions = results[r].extensions || [];
          for (let e = 0; e < extensions.length; e++) {
            const ext = extensions[e];
            const publisherName = ext.publisher?.publisherName ? ext.publisher.publisherName : '';
            const extName = ext.extensionName || '';
            const fullId = `${publisherName}.${extName}`;

            if (!requestedSet[fullId]) continue;

            const extVersions = ext.versions || [];
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
        for (let k = 0; k < ids.length; k++) {
          if (!foundSet[ids[k]]) {
            notFound.push(ids[k]);
          }
        }

        resolve({ status: 'ok', versions: versions, notFound: notFound });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'check_failed', error: 'timeout' });
    });

    req.on('error', (err) => {
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
  resolveLatest: resolveLatest,
};
