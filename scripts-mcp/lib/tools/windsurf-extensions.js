const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

function discover() {
  const configPath = path.join(os.homedir(), '.windsurf', 'extensions', 'extensions.json');
  return fs.existsSync(configPath) ? configPath : null;
}

// ---------------------------------------------------------------------------
// parseExtensions()
// ---------------------------------------------------------------------------

function parseExtensions(configPath, rawJson) {
  if (!Array.isArray(rawJson)) {
    return { extensions: [], skippedNonGallery: 0 };
  }

  const results = [];
  let skippedNonGallery = 0;

  for (let i = 0; i < rawJson.length; i++) {
    const entry = rawJson[i];

    // Must have identifier with id
    if (!entry || !entry.identifier || !entry.identifier.id) {
      continue;
    }

    // Must have a version
    if (typeof entry.version !== 'string') {
      continue;
    }

    // Must be gallery-sourced
    const source = entry.metadata?.source;
    if (source !== 'gallery') {
      skippedNonGallery++;
      continue;
    }

    results.push({
      key: entry.identifier.id,
      id: entry.identifier.id,
      version: entry.version,
      pinned: !!entry.metadata?.pinned,
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
  parseExtensions: parseExtensions,
};
