// =============================================================================
// Tests for update-mcp.js (CLI entry point)
// =============================================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./update-mcp.js');

// ---------------------------------------------------------------------------
// parseArgs: default (no flags)
// ---------------------------------------------------------------------------

test('parseArgs: no flags returns defaults', function () {
  var result = parseArgs([]);
  assert.equal(result.dryRun, false);
  assert.equal(result.check, false);
  assert.equal(result.toolName, null);
  assert.equal(result.json, false);
  assert.equal(result.force, false);
});

// ---------------------------------------------------------------------------
// parseArgs: individual flags
// ---------------------------------------------------------------------------

test('parseArgs: --dry-run', function () {
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('parseArgs: --check', function () {
  assert.equal(parseArgs(['--check']).check, true);
});

test('parseArgs: --json', function () {
  assert.equal(parseArgs(['--json']).json, true);
});

test('parseArgs: --force', function () {
  assert.equal(parseArgs(['--force']).force, true);
});

test('parseArgs: --tool NAME', function () {
  var result = parseArgs(['--tool', 'cursor']);
  assert.equal(result.toolName, 'cursor');
});

// ---------------------------------------------------------------------------
// parseArgs: flag combinations
// ---------------------------------------------------------------------------

test('parseArgs: multiple flags combined', function () {
  var result = parseArgs(['--dry-run', '--json', '--tool', 'cline']);
  assert.equal(result.dryRun, true);
  assert.equal(result.json, true);
  assert.equal(result.toolName, 'cline');
  assert.equal(result.check, false);
});

// ---------------------------------------------------------------------------
// parseArgs: --help
// ---------------------------------------------------------------------------

test('parseArgs: --help returns help flag', function () {
  var result = parseArgs(['--help']);
  assert.equal(result.help, true);
});

test('parseArgs: -h returns help flag', function () {
  var result = parseArgs(['-h']);
  assert.equal(result.help, true);
});

// ---------------------------------------------------------------------------
// parseArgs: error cases
// ---------------------------------------------------------------------------

test('parseArgs: --tool without name returns error', function () {
  var result = parseArgs(['--tool']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('--tool requires'), 'should mention --tool');
});

test('parseArgs: --tool followed by flag returns error', function () {
  var result = parseArgs(['--tool', '--dry-run']);
  assert.ok(result.error, 'should have error');
});

test('parseArgs: unknown flag returns error', function () {
  var result = parseArgs(['--bogus']);
  assert.ok(result.error, 'should have error');
  assert.ok(result.error.includes('Unknown flag'), 'should mention unknown flag');
});

test('parseArgs: positional arg returns error', function () {
  var result = parseArgs(['something']);
  assert.ok(result.error, 'should have error for positional arg');
});
