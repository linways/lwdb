import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { encryptSecret, decryptSecret, isEncrypted, makeCodec } from '../server/lib/secret.mjs';

const KEY = randomBytes(32);

test('encrypt → decrypt round-trips and the blob is tagged + opaque', () => {
  const blob = encryptSecret('hunter2', KEY);
  assert.ok(isEncrypted(blob), 'carries the enc:1: prefix');
  assert.ok(!blob.includes('hunter2'), 'ciphertext does not leak the plaintext');
  assert.equal(decryptSecret(blob, KEY), 'hunter2');
});

test('each encryption uses a fresh IV (ciphertexts differ for the same input)', () => {
  assert.notEqual(encryptSecret('same', KEY), encryptSecret('same', KEY));
});

test('empty password is stored as-is (never encrypted)', () => {
  assert.equal(encryptSecret('', KEY), '');
  assert.equal(encryptSecret(null, KEY), '');
  assert.equal(encryptSecret(undefined, KEY), '');
});

test('decrypt passes through legacy plaintext and empty values', () => {
  assert.equal(decryptSecret('legacy-plaintext-pw', KEY), 'legacy-plaintext-pw');
  assert.equal(decryptSecret('', KEY), '');
  assert.equal(decryptSecret(null, KEY), '');
});

test('decrypt with the wrong key throws (auth tag mismatch)', () => {
  const blob = encryptSecret('secret', KEY);
  assert.throws(() => decryptSecret(blob, randomBytes(32)));
});

test('a tampered ciphertext throws', () => {
  const blob = encryptSecret('secret', KEY);
  const tampered = blob.slice(0, -4) + (blob.endsWith('A') ? 'B' : 'A') + blob.slice(-3);
  assert.throws(() => decryptSecret(tampered, KEY));
});

test('makeCodec binds a key into encrypt/decrypt', () => {
  const codec = makeCodec(KEY);
  assert.equal(codec.decrypt(codec.encrypt('via-codec')), 'via-codec');
});
