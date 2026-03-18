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
    location: { path: `/fake/${id}-${version}` },
    metadata: {
      installedTimestamp: 1,
      pinned: !!pinned,
      source: 'gallery',
      id: '00000000-0000-0000-0000-000000000000',
    },
  };
}

function makeVsixEntry(id, version) {
  return {
    identifier: { id: id, uuid: '11111111-1111-1111-1111-111111111111' },
    version: version,
    location: { path: `/fake/${id}-${version}` },
    metadata: { installedTimestamp: 1, pinned: false, source: 'vsix', id: '11111111-1111-1111-1111-111111111111' },
  };
}

function makeNoSourceEntry(id, version) {
  return {
    identifier: { id: id, uuid: '22222222-2222-2222-2222-222222222222' },
    version: version,
    location: { path: `/fake/${id}-${version}` },
    metadata: { installedTimestamp: 1, pinned: false },
  };
}

// --- discover() tests ---

describe('cursor-extensions discover()', () => {
  beforeEach(() => {
    restoreHomedir();
  });
  afterEach(() => {
    restoreHomedir();
  });

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
      makeGalleryEntry('geddski.macros', '1.2.1', true),
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
    const rawJson = [makeGalleryEntry('ms-python.pylance', '1.0.0', false), makeVsixEntry('some.vsix-ext', '2.0.0')];

    const result = mod.parseExtensions('/fake/path', rawJson);

    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].id, 'ms-python.pylance');
    assert.equal(result.skippedNonGallery, 1);
  });

  it('excludes extensions with undefined source', () => {
    const mod = freshModule();
    const rawJson = [makeGalleryEntry('gallery.ext', '1.0.0', false), makeNoSourceEntry('nosource.ext', '2.0.0')];

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
      { identifier: { id: 'no-version' }, version: '1.0.0', metadata: { source: 'gallery' } }, // no uuid, but valid
    ];

    const result = mod.parseExtensions('/fake/path', rawJson);

    // Should include valid entries, skip malformed
    assert.ok(result.extensions.length >= 2);
    assert.ok(result.extensions.some((e) => e.id === 'valid.ext'));
    assert.ok(result.extensions.some((e) => e.id === 'no-version'));
  });

  it('handles non-array rawJson gracefully', () => {
    const mod = freshModule();
    const result = mod.parseExtensions('/fake/path', { not: 'an array' });

    assert.ok(Array.isArray(result.extensions));
    assert.equal(result.extensions.length, 0);
    assert.equal(result.skippedNonGallery, 0);
  });
});
