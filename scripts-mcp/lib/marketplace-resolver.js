// =============================================================================
// marketplace-resolver.js -- VS Code Marketplace API client
//
// Sends batch extension version queries to the VS Code Marketplace API.
// Returns latest versions for each queried extension ID.
//
// Zero new dependencies — uses Node.js built-in https module.
// =============================================================================

'use strict';

var https = require('node:https');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var DEFAULT_TIMEOUT_MS = 10000;
var API_URL = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';
var BATCH_SIZE = 1000;

// flags: IncludeLatestVersionOnly (8) + ExcludeNonValidated (768) = 776
// Adding IncludeAssetUri (128) + IncludeFiles (64) + IncludeVersionProperties (32) = 976
var DEFAULT_FLAGS = 976;

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
