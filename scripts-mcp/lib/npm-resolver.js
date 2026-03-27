const https = require('node:https');

// -------------------------------------------------------
// Constants
// -------------------------------------------------------

const FLOATING_TAGS = new Set(['latest', 'next', 'canary', 'beta', 'alpha', 'rc', 'nightly', 'experimental']);
const GIT_PREFIXES = ['github:', 'git+', 'https://', 'http://', 'git://', 'git@'];
const DEFAULT_TIMEOUT_MS = 5000;

// -------------------------------------------------------
// extractPinnedVersion(args)
// -------------------------------------------------------

/**
 * Extract npm package name and pinned version from an npx args array.
 *
 * @param {string[]} args - The args array from an MCP server config (e.g. ["-y", "@pkg/name@1.2.3"])
 * @returns {{ pkg: string, pinned: string } | { status: string }}
 */
function extractPinnedVersion(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return { status: 'not_npm' };
  }

  // Find the package specifier argument (skip flags like -y, --yes, etc.)
  const pkgArg = args.find((a) => !a.startsWith('-'));

  if (!pkgArg) {
    return { status: 'not_npm' };
  }

  // Check if it's a git URL
  for (const prefix of GIT_PREFIXES) {
    if (pkgArg.startsWith(prefix)) {
      return { status: 'not_npm' };
    }
  }

  // For scoped packages (@scope/name), the first @ is the scope prefix.
  // We need to find the @ that separates the package name from the version.
  let pkg;
  let version;

  if (pkgArg.startsWith('@')) {
    // Scoped package: @scope/name@version or @scope/name@version/sub/path
    // The version separator is the SECOND @
    const firstSlash = pkgArg.indexOf('/');
    if (firstSlash === -1) {
      return { status: 'not_npm' };
    }
    const versionAt = pkgArg.indexOf('@', firstSlash + 1);
    if (versionAt === -1) {
      // No version specified — floating
      return { status: 'skipped_floating', pkg: pkgArg, pkgArg, pinned: null };
    }
    pkg = pkgArg.substring(0, versionAt);
    version = pkgArg.substring(versionAt + 1);
  } else {
    // Unscoped package: name@version or name@version/sub/path
    const versionAt = pkgArg.indexOf('@');
    if (versionAt === -1) {
      return { status: 'skipped_floating', pkg: pkgArg, pkgArg, pinned: null };
    }
    pkg = pkgArg.substring(0, versionAt);
    version = pkgArg.substring(versionAt + 1);
  }

  // Strip subpath from version (e.g. "1.2.3/sub/path" -> "1.2.3")
  const subpathSlash = version.indexOf('/');
  if (subpathSlash !== -1) {
    version = version.substring(0, subpathSlash);
  }

  // Check if version is a floating tag
  if (FLOATING_TAGS.has(version.toLowerCase())) {
    return { status: 'skipped_floating', pkg, pkgArg, pinned: version };
  }

  // Check if version is a semver range (not a pinned version)
  const RANGE_PREFIXES = ['^', '~', '>=', '<=', '>', '<', '*', 'x'];
  const isRange = RANGE_PREFIXES.some(p => version.startsWith(p)) || version.includes('||') || version.includes(' - ');
  if (isRange) {
    return { status: 'skipped_floating', pkg, pkgArg, pinned: version };
  }

  return { pkg, pkgArg, pinned: version };
}

// -------------------------------------------------------
// resolveLatest(pkg, timeoutMs)
// -------------------------------------------------------

/**
 * Query the npm registry for the latest version of a package.
 * Uses raw HTTPS — no external dependencies.
 *
 * @param {string} pkg - npm package name (e.g. "@anthropic/mcp-server")
 * @param {number} [timeoutMs=5000] - Request timeout in milliseconds
 * @returns {Promise<{ status: string, pkg?: string, latest?: string, error?: string }>}
 */
function resolveLatest(pkg, timeoutMs) {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const encoded = encodeURIComponent(pkg);
    const url = `https://registry.npmjs.org/${encoded}/latest`;

    const req = https.get(url, { timeout }, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const data = JSON.parse(body);
            resolve({ status: 'ok', pkg, latest: data.version });
          } catch {
            resolve({ status: 'check_failed', pkg, error: 'invalid JSON response' });
          }
        } else if (res.statusCode === 404) {
          resolve({ status: 'not_found', pkg });
        } else if (res.statusCode === 429) {
          resolve({ status: 'check_failed', pkg, error: 'rate_limited' });
        } else {
          resolve({ status: 'check_failed', pkg, error: `HTTP ${res.statusCode}` });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'check_failed', pkg, error: 'timeout' });
    });

    req.on('error', (err) => {
      resolve({ status: 'check_failed', pkg, error: err.message });
    });
  });
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

module.exports = {
  extractPinnedVersion,
  resolveLatest,
};
