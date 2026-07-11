import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueForSetdb } from '../server/lib/setdbIssue.mjs';

const envelope = (over = {}) => ({
  schema: 'lwr/v1', ok: true,
  data: {
    id: 126730, subject: 'Mark entry fails',
    description: 'College name - LCSS\n\nDatabase and CHT Instance -> test_lcss64\n\nSteps…',
    custom_fields: [
      { id: 2, name: 'College', value: 'LCSS' },
      { id: 79, name: 'Developer', value: '' },
    ],
    ...over,
  },
});

test('extracts college and db name', () => {
  const r = parseIssueForSetdb(envelope());
  assert.deepEqual(r, { college: 'LCSS', dbName: 'test_lcss64' });
});

test('db line variants: colon and no arrow', () => {
  const r = parseIssueForSetdb(envelope({
    description: 'Database and CHT Instance : test_mbcetv465',
  }));
  assert.equal(r.dbName, 'test_mbcetv465');
});

test('missing db line → dbName null, college still returned', () => {
  const r = parseIssueForSetdb(envelope({ description: 'no db info here' }));
  assert.deepEqual(r, { college: 'LCSS', dbName: null });
});

test('header phrase without separator + plain word → dbName null', () => {
  const r = parseIssueForSetdb(envelope({ description: 'Database and CHT Instance for LCSS' }));
  assert.deepEqual(r, { college: 'LCSS', dbName: null });
});

test('trailing markup/punctuation is not captured', () => {
  assert.equal(parseIssueForSetdb(envelope({
    description: 'Database and CHT Instance -> test_lcss64</strong>',
  })).dbName, 'test_lcss64');
  assert.equal(parseIssueForSetdb(envelope({
    description: 'Database and CHT Instance -> test_lcss64.',
  })).dbName, 'test_lcss64');
});

test('empty or missing college cf → college null', () => {
  assert.equal(parseIssueForSetdb(envelope({ custom_fields: [] })).college, null);
  assert.equal(parseIssueForSetdb(envelope({
    custom_fields: [{ id: 2, name: 'College', value: '' }],
  })).college, null);
});

test('failed envelope → throws with lwr message', () => {
  assert.throws(
    () => parseIssueForSetdb({ ok: false, error: { code: 'NOT_FOUND', message: 'Issue 9 not found' } }),
    /Issue 9 not found/,
  );
});
