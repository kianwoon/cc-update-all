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
  name: 'windsurf-extensions',
  discover: discover,
  parseExtensions: parseExtensions
};
