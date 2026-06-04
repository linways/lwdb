import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSql, assertReadOnly } from '../server/lib/sqlGuard.mjs';

test('select is read-only', () => {
  const info = inspectSql('SELECT 1');
  assert.equal(info.allReadOnly, true);
  assert.deepEqual(info.verbs, ['SELECT']);
});

test('multiple selects are read-only', () => {
  const info = inspectSql('SELECT 1; SELECT 2;');
  assert.equal(info.allReadOnly, true);
  assert.equal(info.stmts.length, 2);
});

test('UPDATE is blocked', () => {
  assert.throws(() => assertReadOnly('UPDATE x SET y = 1'), { code: 'READONLY_BLOCKED' });
});

test('CTE with INSERT inside is blocked', () => {
  // MySQL doesn't actually support this, but we still want to be safe.
  assert.throws(() => assertReadOnly('WITH t AS (INSERT INTO x VALUES (1)) SELECT * FROM t'), {
    code: 'READONLY_BLOCKED',
  });
});

test('DROP TABLE is blocked', () => {
  assert.throws(() => assertReadOnly('DROP TABLE x'), { code: 'READONLY_BLOCKED' });
});

test('SHOW DATABASES is read-only', () => {
  const info = inspectSql('SHOW DATABASES');
  assert.equal(info.allReadOnly, true);
});

test('comments do not bypass guard', () => {
  assert.throws(() => assertReadOnly('-- harmless\nDELETE FROM users'), { code: 'READONLY_BLOCKED' });
  assert.throws(() => assertReadOnly('/* */ DELETE FROM users'), { code: 'READONLY_BLOCKED' });
  assert.throws(() => assertReadOnly('# DELETE\nDROP TABLE x'), { code: 'READONLY_BLOCKED' });
});

test('strings containing write verbs are not flagged', () => {
  const info = inspectSql("SELECT 'DROP TABLE x' AS s");
  assert.equal(info.allReadOnly, true);
});

test('backticks with write verbs are not flagged', () => {
  const info = inspectSql('SELECT `DROP_COL` FROM t');
  assert.equal(info.allReadOnly, true);
});

test('empty SQL throws EMPTY_SQL', () => {
  assert.throws(() => assertReadOnly('   '), { code: 'EMPTY_SQL' });
  assert.throws(() => assertReadOnly('-- only a comment'), { code: 'EMPTY_SQL' });
});

test('EXPLAIN is read-only', () => {
  const info = inspectSql('EXPLAIN SELECT * FROM t');
  assert.equal(info.allReadOnly, true);
});

test('semicolons inside strings do not split statements', () => {
  const info = inspectSql("SELECT 'a; b' AS s");
  assert.equal(info.stmts.length, 1);
});

test('SET is treated as write (server state change)', () => {
  assert.throws(() => assertReadOnly('SET autocommit=0'), { code: 'READONLY_BLOCKED' });
});

// Regression: earlier versions stripped string content from the returned
// statements, so 'foo'-style literals reached MySQL as ''. inspectSql must
// preserve the raw statement text verbatim.
test('inspectSql preserves string literals verbatim', () => {
  const sql = "SELECT * FROM users WHERE name = 'alice' AND status = 'ok'";
  const info = inspectSql(sql);
  assert.equal(info.stmts.length, 1);
  assert.equal(info.stmts[0], sql);
});

test('inspectSql preserves backtick-quoted reserved-word identifiers', () => {
  const sql = 'SELECT * FROM `groups` WHERE id = 1';
  const info = inspectSql(sql);
  assert.equal(info.stmts[0], sql);
  assert.equal(info.allReadOnly, true);
});

test('inspectSql preserves comments inside the statement', () => {
  const sql = "SELECT 1 /* hello world */ -- trailing\nFROM dual";
  const info = inspectSql(sql);
  assert.equal(info.stmts.length, 1);
  // exact match: the original text round-trips (trimmed)
  assert.equal(info.stmts[0], sql.trim());
});

test('inspectSql still splits multiple statements correctly with literals', () => {
  const sql = "SELECT 'a;b' AS x; SELECT 'c;d' AS y";
  const info = inspectSql(sql);
  assert.equal(info.stmts.length, 2);
  assert.equal(info.stmts[0], "SELECT 'a;b' AS x");
  assert.equal(info.stmts[1], "SELECT 'c;d' AS y");
});

test('inspectSql does not split on a ; inside a backtick identifier', () => {
  // Pathological but valid: ; inside a backtick-quoted identifier
  const sql = 'SELECT * FROM `weird;name`';
  const info = inspectSql(sql);
  assert.equal(info.stmts.length, 1);
  assert.equal(info.stmts[0], sql);
});
