import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeLauncherManifest, cmpSemver, pickDebAsset } from '../install.mjs';

test('cmpSemver orders releases correctly', () => {
  assert.ok(cmpSemver('0.4.0', '0.1.2') > 0);
  assert.ok(cmpSemver('v0.4.0', 'v0.4.0') === 0);
  assert.ok(cmpSemver('0.1.2', '0.4.0') < 0);
  assert.ok(cmpSemver('1.0.0', '0.9.9') > 0);
});

test('pickDebAsset prefers amd64 .deb, falls back, else null', () => {
  const assets = [
    { name: 'lwdb_0.4.0_aarch64.rpm', browser_download_url: 'rpm' },
    { name: 'lwdb_0.4.0_amd64.deb', browser_download_url: 'amd64' },
    { name: 'lwdb_0.4.0_arm64.deb', browser_download_url: 'arm64' },
  ];
  assert.equal(pickDebAsset(assets), 'amd64');
  assert.equal(pickDebAsset([{ name: 'x_arm64.deb', browser_download_url: 'only' }]), 'only');
  assert.equal(pickDebAsset([{ name: 'x.AppImage', browser_download_url: 'a' }]), null);
  assert.equal(pickDebAsset(undefined), null);
});

test('writeLauncherManifest writes a valid manifest to the given dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lwdb-launch-'));
  try {
    const m = writeLauncherManifest(dir, { quiet: true });
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
