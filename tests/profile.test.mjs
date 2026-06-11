import test from 'node:test';
import assert from 'node:assert/strict';

import { quoteIdent } from '../server/lib/ident.mjs';
import {
  buildSampleSql, buildAggregateSql, parseAggregateRow, buildTopValuesSql, shouldFetchTop,
} from '../server/lib/profile.mjs';

// ---------- quoteIdent ----------

test('quoteIdent backticks identifiers and doubles embedded backticks', () => {
  assert.equal(quoteIdent('students'), '`students`');
  assert.equal(quoteIdent('we`ird'), '`we``ird`');
});

test('quoteIdent rejects empty or non-string identifiers', () => {
  assert.throws(() => quoteIdent(''), /identifier/);
  assert.throws(() => quoteIdent(null), /identifier/);
});

// ---------- sample ----------

test('buildSampleSql selects * with a bounded limit', () => {
  assert.equal(buildSampleSql('mydb', 'students', 3), 'SELECT * FROM `mydb`.`students` LIMIT 3');
  // limit is clamped to [1, 100] and defaults to 5
  assert.equal(buildSampleSql('mydb', 'students'), 'SELECT * FROM `mydb`.`students` LIMIT 5');
  assert.equal(buildSampleSql('mydb', 'students', 5000), 'SELECT * FROM `mydb`.`students` LIMIT 100');
});

// ---------- profile aggregates ----------

test('buildAggregateSql aggregates nulls/distinct/min/max per column over a bounded sample', () => {
  const sql = buildAggregateSql(['a', 'b'], { db: 'd', table: 't', sampleSize: 1000 });
  assert.equal(sql,
    'SELECT COUNT(*) AS _n, '
    + 'SUM(`a` IS NULL) AS n0, COUNT(DISTINCT `a`) AS d0, MIN(`a`) AS mn0, MAX(`a`) AS mx0, '
    + 'SUM(`b` IS NULL) AS n1, COUNT(DISTINCT `b`) AS d1, MIN(`b`) AS mn1, MAX(`b`) AS mx1 '
    + 'FROM (SELECT `a`, `b` FROM `d`.`t` LIMIT 1000) s');
});

test('buildAggregateSql with exact=true scans the real table', () => {
  const sql = buildAggregateSql(['a'], { db: 'd', table: 't', exact: true });
  assert.match(sql, /FROM `d`\.`t`$/);
  assert.ok(!sql.includes('LIMIT'));
});

test('parseAggregateRow maps indexed aliases back to column stats', () => {
  const row = { _n: 1000, n0: 10, d0: 3, mn0: 'a', mx0: 'z', n1: 0, d1: 990, mn1: 1, mx1: 99 };
  const out = parseAggregateRow(row, ['status', 'amount']);
  assert.equal(out.rowsScanned, 1000);
  assert.deepEqual(out.columns.status, { nulls: 10, nullPct: 1, distinct: 3, min: 'a', max: 'z' });
  assert.deepEqual(out.columns.amount, { nulls: 0, nullPct: 0, distinct: 990, min: 1, max: 99 });
});

// ---------- top values ----------

test('buildTopValuesSql groups the sampled column by frequency', () => {
  const sql = buildTopValuesSql('status', { db: 'd', table: 't', sampleSize: 1000, top: 5 });
  assert.equal(sql,
    'SELECT `status` AS v, COUNT(*) AS n '
    + 'FROM (SELECT `status` FROM `d`.`t` LIMIT 1000) s '
    + 'GROUP BY `status` ORDER BY n DESC LIMIT 5');
});

test('shouldFetchTop only for low-cardinality non-null columns', () => {
  assert.equal(shouldFetchTop(3), true);
  assert.equal(shouldFetchTop(50), true);
  assert.equal(shouldFetchTop(51), false);
  assert.equal(shouldFetchTop(0), false);
});
