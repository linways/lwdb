import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLauncherManifest } from '../install.mjs';

test('writeLauncherManifest writes a valid manifest to the given dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-launch-'));
  try {
    const m = writeLauncherManifest(dir);
    assert.equal(m.node, process.execPath);
    assert.ok(m.serverEntry.endsWith('/server/index.mjs'), `serverEntry: ${m.serverEntry}`);
    assert.ok(m.cli.endsWith('/bin/lwdb.mjs'), `cli: ${m.cli}`);
    assert.ok(m.cwd.length > 0);
    assert.ok(m.version, 'version present');
    const onDisk = JSON.parse(await readFile(join(dir, 'launcher.json'), 'utf8'));
    assert.equal(onDisk.node, process.execPath);
    assert.equal(onDisk.serverEntry, m.serverEntry);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
