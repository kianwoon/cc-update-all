'use strict';

const fs = require('node:fs');

/**
 * Reads and parses a JSON config file.
 *
 * @param {string} configPath - Path to the JSON file.
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
function readConfig(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: `config file not found: ${configPath}` };
    }
    if (err instanceof SyntaxError) {
      return { ok: false, error: `malformed JSON in ${configPath}: ${err.message}` };
    }
    return { ok: false, error: `failed to read config: ${err.message}` };
  }
}

/**
 * Writes JSON data to a config file with .bak backup and mtime safety check.
 *
 * Steps:
 * 1. Record mtimeMs of existing file (read phase mtime)
 * 2. Write .bak backup (only if file existed)
 * 3. Write .tmp staging file with new content
 * 4. Rename .tmp to actual path (atomic on POSIX)
 * 5. Verify mtime hasn't changed — if configPath's mtime still matches
 *    the original mtime recorded in step 1, an external process restored
 *    the original file after our rename (mtime conflict). Restore from .bak.
 * 6. Return { ok: true }
 *
 * On any failure after .bak is created, attempts to restore from .bak.
 *
 * @param {string} configPath - Path to the JSON file.
 * @param {object} data - Data to write.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function writeConfig(configPath, data) {
  const bakPath = configPath + '.bak';
  const tmpPath = configPath + '.tmp';

  // Step 1: Record mtime of existing file
  let originalMtimeMs = null;
  let hadOriginal = false;

  try {
    const stat = fs.statSync(configPath);
    originalMtimeMs = stat.mtimeMs;
    hadOriginal = true;
  } catch (err) {
    // File doesn't exist yet — no backup or mtime check needed
  }

  const json = JSON.stringify(data, null, 2) + '\n';

  try {
    // Step 2: Write .bak backup (only if original file existed)
    if (hadOriginal) {
      try {
        fs.copyFileSync(configPath, bakPath);
      } catch (err) {
        return { ok: false, error: `failed to create backup: ${err.message}` };
      }
    }

    // Step 3: Write .tmp staging file
    try {
      fs.writeFileSync(tmpPath, json, 'utf8');
    } catch (err) {
      if (hadOriginal) {
        try { fs.copyFileSync(bakPath, configPath); } catch (_) { /* best effort */ }
      }
      return { ok: false, error: `failed to write staging file: ${err.message}` };
    }

    // Step 4: Rename .tmp to actual path (atomic on POSIX)
    try {
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
      if (hadOriginal) {
        try { fs.copyFileSync(bakPath, configPath); } catch (_) { /* best effort */ }
      }
      return { ok: false, error: `failed to rename staging file: ${err.message}` };
    }

    // Step 5: Verify mtime hasn't been externally modified.
    // After the atomic rename, configPath has the .tmp file's mtime (recent).
    // If an external process overwrote the file back to its original content
    // after our rename, the mtime would match originalMtimeMs — indicating conflict.
    if (hadOriginal && originalMtimeMs !== null) {
      try {
        const statAfter = fs.statSync(configPath);
        if (statAfter.mtimeMs === originalMtimeMs) {
          // mtime unchanged — external process likely restored the original file.
          // Restore from .bak to ensure original content is intact.
          try {
            fs.copyFileSync(bakPath, configPath);
          } catch (_) { /* best effort */ }
          return { ok: false, error: 'mtime safety check failed: file was modified externally during write' };
        }
      } catch (err) {
        try {
          fs.copyFileSync(bakPath, configPath);
        } catch (_) { /* best effort */ }
        return { ok: false, error: `post-write verification failed: ${err.message}` };
      }
    }

    // Clean up .tmp if it somehow still exists
    try { fs.unlinkSync(tmpPath); } catch (_) { /* already removed by rename */ }

    // Step 6: Success
    return { ok: true };
  } catch (err) {
    // Catch-all: restore from backup if possible
    if (hadOriginal) {
      try { fs.copyFileSync(bakPath, configPath); } catch (_) { /* best effort */ }
    }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* best effort */ }
    return { ok: false, error: `unexpected error during write: ${err.message}` };
  }
}

module.exports = { readConfig, writeConfig };
