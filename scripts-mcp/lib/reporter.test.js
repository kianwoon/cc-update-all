'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const reporter = require('./reporter.js');

var sampleData = {
  tools: {
    cursor: {
      status: 'ok',
      configPath: '/Users/test/.cursor/mcp.json',
      servers: [
        { key: 'anthropic', package: '@anthropic/mcp-server', status: 'updated', current: '1.2.3', latest: '1.3.0' },
        { key: 'github', package: '@modelcontextprotocol/server-github', status: 'current', current: null, latest: '2.1.0' },
        { key: 'local-tool', status: 'skipped_non_npx' }
      ]
    },
    cline: {
      status: 'ok',
      configPath: '/Users/test/Library/.../cline_mcp_settings.json',
      servers: [
        { key: 'anthropic', package: '@anthropic/mcp-server', status: 'current', current: null, latest: '1.3.0' }
      ]
    }
  },
  summary: { updated: 1, current: 3, skipped: 1, failed: 0 }
};

test('reporter.formatText: includes tool names', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('cursor'), 'should mention cursor');
  assert.ok(output.includes('cline'), 'should mention cline');
});

test('reporter.formatText: includes summary counts', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('Updated: 1'), 'should show updated count');
  assert.ok(output.includes('Current: 3'), 'should show current count');
  assert.ok(output.includes('Skipped: 1'), 'should show skipped count');
  assert.ok(output.includes('Failed: 0'), 'should show failed count');
});

test('reporter.formatText: shows version arrow for updated servers', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('1.2.3 -> 1.3.0'), 'should show version arrow');
});

test('reporter.formatText: shows not npx-based for non-npx servers', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('(not npx-based)'), 'should show non-npx message');
});

test('reporter.formatText: shows singular "tool" for count of 1', function () {
  var output = reporter.formatText(sampleData, 1);
  assert.ok(output.includes('1 tool'), 'should use singular');
});

test('reporter.formatText: shows plural "tools" for count > 1', function () {
  var output = reporter.formatText(sampleData, 2);
  assert.ok(output.includes('2 tools'), 'should use plural');
});

test('reporter.formatJson: produces valid JSON', function () {
  var output = reporter.formatJson(sampleData);
  var parsed = JSON.parse(output);
  assert.ok(parsed.tools, 'should have tools');
  assert.ok(parsed.summary, 'should have summary');
  assert.equal(parsed.summary.updated, 1);
  assert.equal(parsed.tools.cursor.servers.length, 3);
});

test('reporter.formatText: handles empty tools', function () {
  var emptyData = { tools: {}, summary: { updated: 0, current: 0, skipped: 0, failed: 0 } };
  var output = reporter.formatText(emptyData, 0);
  assert.ok(output.includes('SUMMARY'), 'should still show summary');
});

test('reporter.formatText: handles check_failed with error message', function () {
  var failData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'bad-pkg', package: 'bad-pkg', status: 'check_failed', error: 'network timeout' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 0, failed: 1 }
  };
  var output = reporter.formatText(failData, 1);
  assert.ok(output.includes('network timeout'), 'should show error message');
  assert.ok(output.includes('[FAILED]'), 'should show FAILED label');
});

test('reporter.formatText: handles not_found status', function () {
  var notFoundData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'private-pkg', package: '@private/pkg', status: 'not_found' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 1, failed: 0 }
  };
  var output = reporter.formatText(notFoundData, 1);
  assert.ok(output.includes('(not on npm)'), 'should show not on npm message');
});

test('reporter.formatText: handles skipped_floating status', function () {
  var floatingData = {
    tools: {
      cursor: {
        status: 'ok',
        configPath: '/fake',
        servers: [
          { key: 'float-pkg', package: '@scope/pkg', status: 'skipped_floating' }
        ]
      }
    },
    summary: { updated: 0, current: 0, skipped: 1, failed: 0 }
  };
  var output = reporter.formatText(floatingData, 1);
  assert.ok(output.includes('(floating version)'), 'should show floating version message');
});
