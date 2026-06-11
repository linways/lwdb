import test from 'node:test';
import assert from 'node:assert/strict';

import { createMcpServer, JSONRPC } from '../server/lib/mcpServer.mjs';

function makeServer(extra = {}) {
  const calls = [];
  const tools = [
    {
      name: 'echo',
      description: 'Echo the input back',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      handler: async (args) => { calls.push(args); return { echoed: args.text }; },
    },
    {
      name: 'boom',
      description: 'Always throws a coded error',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => { throw Object.assign(new Error('it broke'), { code: 'DB_ERROR' }); },
    },
    ...(extra.tools || []),
  ];
  return { server: createMcpServer({ serverInfo: { name: 'lwdb', version: '9.9.9' }, tools }), calls };
}

const init = (id = 1, protocolVersion = '2025-11-25') => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'c', version: '1' } },
});

test('initialize advertises tools capability, serverInfo, and echoes a supported protocolVersion', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage(init(1, '2025-11-25'));
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-11-25');
  assert.ok(res.result.capabilities.tools, 'advertises tools capability');
  assert.deepEqual(res.result.serverInfo, { name: 'lwdb', version: '9.9.9' });
});

test('initialize falls back to the latest supported version for an unknown request', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage(init(1, '1999-01-01'));
  assert.equal(res.result.protocolVersion, '2025-11-25');
});

test('notifications/initialized produces no response', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});

test('ping returns an empty result', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 7, result: {} });
});

test('tools/list returns each tool name, description and inputSchema (no handler leaked)', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['echo', 'boom']);
  const echo = res.result.tools[0];
  assert.equal(echo.description, 'Echo the input back');
  assert.equal(echo.inputSchema.type, 'object');
  assert.equal('handler' in echo, false, 'handler must not be serialized');
});

test('tools/call dispatches to the handler and wraps the result as JSON text content', async () => {
  const { server, calls } = makeServer();
  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hi' } },
  });
  assert.deepEqual(calls, [{ text: 'hi' }]);
  assert.equal(res.result.isError, false);
  assert.equal(res.result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(res.result.content[0].text), { echoed: 'hi' });
});

test('tools/call reports handler failures as isError content carrying the stable code', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} },
  });
  assert.equal(res.error, undefined, 'tool failure is NOT a protocol error');
  assert.equal(res.result.isError, true);
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.error.code, 'DB_ERROR');
  assert.match(payload.error.message, /it broke/);
});

test('tools/call on an unknown tool is a -32602 invalid params error', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} },
  });
  assert.equal(res.error.code, JSONRPC.INVALID_PARAMS);
  assert.match(res.error.message, /nope/);
});

test('an unknown method returns -32601 method not found', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
  assert.equal(res.error.code, JSONRPC.METHOD_NOT_FOUND);
});

test('an unknown notification (no id) is ignored with no response', async () => {
  const { server } = makeServer();
  const res = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' });
  assert.equal(res, null);
});
