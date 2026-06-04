import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConnections, safeConnection } from '../server/lib/connections.mjs';

test('loadConnections parses host:port form', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-conf-'));
  try {
    await writeFile(join(dir, 'V4-server84.txt'),
      `$AMS_AUTONOMOUS_DB_HOST = $HOST = $DB_HOST  = "127.0.0.1:3381";
       $AMS_AUTONOMOUS_DB_USER = $USER = $DB_USER = "merge";
       $AMS_AUTONOMOUS_DB_PASSWD = $PASSWD = $DB_PASSWD = "secret";\n`);
    await writeFile(join(dir, 'localdb.txt'),
      `$AMS_AUTONOMOUS_DB_HOST = $HOST = $DB_HOST  = "localhost";
       $AMS_AUTONOMOUS_DB_USER = $USER = $DB_USER = "root";
       $AMS_AUTONOMOUS_DB_PASSWD = $PASSWD = $DB_PASSWD = "rootpw";\n`);

    const conns = await loadConnections(dir);
    assert.equal(conns.length, 2);
    // local should sort first
    assert.equal(conns[0].id, 'localdb');
    assert.equal(conns[0].kind, 'local');

    const v4 = conns.find((c) => c.id === 'V4-server84');
    assert.equal(v4.host, '127.0.0.1');
    assert.equal(v4.port, 3381);
    assert.equal(v4.user, 'merge');
    assert.equal(v4.password, 'secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('safeConnection strips password', () => {
  const safe = safeConnection({ id: 'x', host: 'h', port: 1, user: 'u', password: 'pw' });
  assert.equal(safe.password, undefined);
  assert.equal(safe.hasPassword, true);
});

test('loadConnections ignores files lacking required fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-conf-'));
  try {
    await writeFile(join(dir, 'broken.txt'), '$DB_HOST = "x"\n');
    const conns = await loadConnections(dir);
    assert.equal(conns.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
