import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDbServers } from '../server/lib/setdbCommand.mjs';

test('findDbServers returns hits and unreachable servers without one failure blocking the rest', async () => {
  const dbsBy = { a: ['x', 'target'], b: ['y'], c: ['target'] };
  const backend = {
    listDatabases: async (id) => { if (id === 'down') throw new Error('timeout'); return dbsBy[id]; },
  };
  const servers = ['a', 'down', 'b', 'c'].map((id) => ({ id }));
  assert.deepEqual(await findDbServers(backend, servers, 'target'), { hits: ['a', 'c'], unreachable: ['down'] });
});
