const { test } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('./registry.js');

test('registry.listToolNames: returns array of tool names', () => {
  const names = registry.listToolNames();
  assert.ok(Array.isArray(names), 'should return an array');
  assert.ok(names.includes('cursor'), 'should include cursor');
  assert.ok(names.includes('cline'), 'should include cline');
  assert.ok(names.includes('roo-code'), 'should include roo-code');
});

test('registry.getTool: returns cursor tool', () => {
  const tool = registry.getTool('cursor');
  assert.ok(tool, 'should return a tool');
  assert.equal(tool.name, 'cursor');
  assert.equal(typeof tool.discover, 'function');
  assert.equal(typeof tool.parseMcpServers, 'function');
  assert.equal(typeof tool.writeMcpServers, 'function');
});

test('registry.getTool: returns cline tool', () => {
  const tool = registry.getTool('cline');
  assert.ok(tool);
  assert.equal(tool.name, 'cline');
});

test('registry.getTool: returns roo-code tool', () => {
  const tool = registry.getTool('roo-code');
  assert.ok(tool);
  assert.equal(tool.name, 'roo-code');
});

test('registry.getTool: returns null for unknown tool', () => {
  const tool = registry.getTool('nonexistent');
  assert.equal(tool, null);
});

test('registry.discover: returns array of discovered tools', () => {
  const tools = registry.discover();
  assert.ok(Array.isArray(tools), 'should return an array');
  tools.forEach((t) => {
    assert.ok(t.name, 'should have name');
    assert.ok(typeof t.configPath === 'string', 'should have configPath string');
    assert.ok(t.tool, 'should have tool module');
  });
});
