const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./update-extensions.js');

// ---------------------------------------------------------------------------
// parseArgs: default (no flags)
// ---------------------------------------------------------------------------

test('parseArgs: no flags returns defaults', () => {
  const result = parseArgs([]);
  assert.equal(result.toolName, null);
  assert.equal(result.json, false);
  assert.equal(result.includePreRelease, false);
});

// ---------------------------------------------------------------------------
// parseArgs: individual flags
// ---------------------------------------------------------------------------

test('parseArgs: --json', () => {
  assert.equal(parseArgs(['--json']).json, true);
});

test('parseArgs: --include-prerelease', () => {
  assert.equal(parseArgs(['--include-prerelease']).includePreRelease, true);
});

test('parseArgs: --tool NAME', () => {
  const result = parseArgs(['--tool', 'cursor-extensions']);
  assert.equal(result.toolName, 'cursor-extensions');
});

// ---------------------------------------------------------------------------
// parseArgs: flag combinations
// ---------------------------------------------------------------------------

test('parseArgs: multiple flags combined', () => {
  const result = parseArgs(['--json', '--tool', 'windsurf-extensions', '--include-prerelease']);
  assert.equal(result.json, true);
  assert.equal(result.toolName, 'windsurf-extensions');
  assert.equal(result.includePreRelease, true);
});

// ---------------------------------------------------------------------------
// parseArgs: --help
// ---------------------------------------------------------------------------

test('parseArgs: --help returns help flag', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.help, true);
});

test('parseArgs: -h returns help flag', () => {
  const result = parseArgs(['-h']);
  assert.equal(result.help, true);
});

// ---------------------------------------------------------------------------
// parseArgs: error cases
// ---------------------------------------------------------------------------

test('parseArgs: --tool without name returns error', () => {
  const result = parseArgs(['--tool']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('--tool requires'), 'should mention --tool');
});

test('parseArgs: --tool followed by flag returns error', () => {
  const result = parseArgs(['--tool', '--json']);
  assert.ok(result.error, 'should have error');
});

test('parseArgs: unknown flag returns error', () => {
  const result = parseArgs(['--bogus']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('Unknown flag'), 'should mention unknown flag');
});

test('parseArgs: positional arg returns error', () => {
  const result = parseArgs(['something']);
  assert.ok(result.error, 'should have error for positional arg');
});
