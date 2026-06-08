import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUseStatement } from '../web/src/sqlStatements.js';

test('parseUseStatement extracts the db name', () => {
  assert.equal(parseUseStatement('USE mydb'), 'mydb');
  assert.equal(parseUseStatement('use mydb;'), 'mydb');
  assert.equal(parseUseStatement('  USE   test_db2104  '), 'test_db2104');
  assert.equal(parseUseStatement('USE `my-db`;'), 'my-db');
  assert.equal(parseUseStatement('USE `weird db name`'), 'weird db name');
});

test('parseUseStatement returns null for non-USE / compound statements', () => {
  assert.equal(parseUseStatement('SELECT 1'), null);
  assert.equal(parseUseStatement('USE'), null);                 // no db
  assert.equal(parseUseStatement('USE a; SELECT 1'), null);     // not a bare USE
  assert.equal(parseUseStatement('SELECT * FROM users'), null);
  assert.equal(parseUseStatement('-- USE mydb'), null);         // comment, not a statement
  assert.equal(parseUseStatement(''), null);
});
