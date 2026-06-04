import test from 'node:test';
import assert from 'node:assert/strict';
import { required, ensureString, ensureArray, ensureObject, clampInt } from '../server/lib/validate.mjs';

test('required throws on missing fields', () => {
  assert.throws(() => required({ a: 1 }, ['a', 'b']), { code: 'BAD_REQUEST' });
  required({ a: 1, b: 2 }, ['a', 'b']); // no-throw
});

test('ensureString enforces type and length', () => {
  assert.throws(() => ensureString(1, 'x'), { code: 'BAD_REQUEST' });
  assert.throws(() => ensureString('x'.repeat(11), 'x', { maxLen: 10 }), { code: 'BAD_REQUEST' });
  assert.equal(ensureString('ok', 'x'), 'ok');
});

test('ensureArray/object', () => {
  assert.throws(() => ensureArray({}, 'x'), { code: 'BAD_REQUEST' });
  assert.throws(() => ensureObject([], 'x'), { code: 'BAD_REQUEST' });
});

test('clampInt clamps and falls back', () => {
  assert.equal(clampInt('5', { min: 1, max: 10, fallback: 3 }), 5);
  assert.equal(clampInt('100', { min: 1, max: 10, fallback: 3 }), 10);
  assert.equal(clampInt('foo', { min: 1, max: 10, fallback: 3 }), 3);
});
