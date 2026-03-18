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
 * 1. Check if original file exists (for .bak backup and mtime check eligibility)
 * 2. Write .bak backup (only if file existed)
 * 3. Write .tmp staging file with new content
 * 4. Record .tmp file's mtimeMs (after writing)
 * 5. Rename .tmp to configPath (atomic on POSIX; preserves source mtime)
 * 6. Stat configPath — if mtime matches .tmp's recorded mtime, no external
 *    modification occurred. If mtime differs, an external process modified the
 *    file after our rename — restore from .bak.
 *
 * On any failure after .bak is created, attempts to restore from .bak.
 *
 * @param {string} configPath - Path to the JSON file.
 * @param {object} data - Data to write.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function writeConfig(configPath, data) {
  const bakPath = `${configPath}.bak`;
  const tmpPath = `${configPath}.tmp`;

  // Step 1: Check if original file exists
  let hadOriginal = false;

  try {
    fs.statSync(configPath);
    hadOriginal = true;
  } catch (err) {
    // File doesn't exist yet — no backup or mtime check needed
  }

  const json = `${JSON.stringify(data, null, 2)}\n`;

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
        try {
          fs.copyFileSync(bakPath, configPath);
        } catch (_) {
          /* best effort */
        }
      }
      return { ok: false, error: `failed to write staging file: ${err.message}` };
    }

    // Step 4: Record .tmp file's mtime after writing
    let tmpMtimeMs = null;
    try {
      tmpMtimeMs = fs.statSync(tmpPath).mtimeMs;
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        /* best effort */
      }
      if (hadOriginal) {
        try {
          fs.copyFileSync(bakPath, configPath);
        } catch (_) {
          /* best effort */
        }
      }
      return { ok: false, error: `failed to stat staging file: ${err.message}` };
    }

    // Step 5: Rename .tmp to configPath (atomic on POSIX; preserves source mtime)
    try {
      fs.renameSync(tmpPath, configPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        /* best effort */
      }
      if (hadOriginal) {
        try {
          fs.copyFileSync(bakPath, configPath);
        } catch (_) {
          /* best effort */
        }
      }
      return { ok: false, error: `failed to rename staging file: ${err.message}` };
    }

    // Step 6: Verify mtime hasn't been externally modified.
    // rename() preserves the source file's mtime on POSIX, so the post-rename
    // stat of configPath should match the pre-rename .tmp mtime.
    // If it differs, an external process modified the file after our rename.
    if (hadOriginal && tmpMtimeMs !== null) {
      try {
        const statAfter = fs.statSync(configPath);
        if (statAfter.mtimeMs !== tmpMtimeMs) {
          // mtime differs — external process modified the file after our rename.
          // Restore from .bak to ensure original content is intact.
          try {
            fs.copyFileSync(bakPath, configPath);
          } catch (_) {
            /* best effort */
          }
          return { ok: false, error: 'mtime safety check failed: file was modified externally during write' };
        }
      } catch (err) {
        try {
          fs.copyFileSync(bakPath, configPath);
        } catch (_) {
          /* best effort */
        }
        return { ok: false, error: `post-write verification failed: ${err.message}` };
      }
    }

    // Clean up .tmp if it somehow still exists
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* already removed by rename */
    }

    // Step 7: Success
    return { ok: true };
  } catch (err) {
    // Catch-all: restore from backup if possible
    if (hadOriginal) {
      try {
        fs.copyFileSync(bakPath, configPath);
      } catch (_) {
        /* best effort */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* best effort */
    }
    return { ok: false, error: `unexpected error during write: ${err.message}` };
  }
}

module.exports = { readConfig, writeConfig };
