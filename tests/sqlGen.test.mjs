import test from 'node:test';
import assert from 'node:assert/strict';

import { updateCellSql } from '../web/src/sqlGen.js';
import { aliasFor } from '../web/src/sqlCompletion.js';

test('updateCellSql: targets by primary key', () => {
  const sql = updateCellSql('ec_rule', ['id'], { id: 'abc', name: 'X' }, 'name', 'Y');
  assert.equal(sql, "UPDATE `ec_rule` SET `name` = 'Y' WHERE `id` = 'abc' LIMIT 1;");
});

test('updateCellSql: no PK uses full original row (old value of edited col) + NULL handling + escaping', () => {
  const sql = updateCellSql('t', [], { a: 1, b: null, c: "O'Brien" }, 'c', 'New');
  assert.equal(sql, "UPDATE `t` SET `c` = 'New' WHERE `a` = 1 AND `b` IS NULL AND `c` = 'O''Brien' LIMIT 1;");
});

test('aliasFor: initials of word parts; single word → first letter', () => {
  assert.equal(aliasFor('settings'), 's');
  assert.equal(aliasFor('student_total_mark'), 'stm');
  assert.equal(aliasFor('amInstance'), 'ai');
});
