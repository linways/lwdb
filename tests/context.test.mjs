import test from 'node:test';
import assert from 'node:assert/strict';

import { inferRelations, compactColumn, buildContext } from '../server/lib/context.mjs';

// Helpers to build information_schema-shaped fixtures.
const col = (tbl, name, over = {}) => ({
  tbl, name, type: 'int', nullable: 'YES', keyKind: '', defaultValue: null, extra: '', comment: '', ...over,
});
const pk = (tbl, name = 'id', over = {}) => col(tbl, name, { keyKind: 'PRI', nullable: 'NO', extra: 'auto_increment', ...over });

// ---------- inferRelations ----------

test('infers student_id -> students.id via plural-s', () => {
  const rels = inferRelations({
    columns: [pk('students'), pk('attendance'), col('attendance', 'student_id')],
    fks: [],
  });
  assert.deepEqual(rels, [{ tbl: 'attendance', col: 'student_id', refTable: 'students', refCol: 'id', kind: 'inferred' }]);
});

test('infers category_id -> categories.id via y->ies plural', () => {
  const rels = inferRelations({
    columns: [pk('categories'), col('products', 'category_id')],
    fks: [],
  });
  assert.deepEqual(rels, [{ tbl: 'products', col: 'category_id', refTable: 'categories', refCol: 'id', kind: 'inferred' }]);
});

test('infers class_id -> classes.id via es plural', () => {
  const rels = inferRelations({
    columns: [pk('classes'), col('students', 'class_id')],
    fks: [],
  });
  assert.deepEqual(rels, [{ tbl: 'students', col: 'class_id', refTable: 'classes', refCol: 'id', kind: 'inferred' }]);
});

test('infers batch_id -> batch.id when the table name is singular', () => {
  const rels = inferRelations({
    columns: [pk('batch'), col('students', 'batch_id')],
    fks: [],
  });
  assert.deepEqual(rels, [{ tbl: 'students', col: 'batch_id', refTable: 'batch', refCol: 'id', kind: 'inferred' }]);
});

test('infers when the target PK is named like the column (students.student_id)', () => {
  const rels = inferRelations({
    columns: [pk('students', 'student_id'), col('attendance', 'student_id')],
    fks: [],
  });
  assert.deepEqual(rels, [{ tbl: 'attendance', col: 'student_id', refTable: 'students', refCol: 'student_id', kind: 'inferred' }]);
});

test('does not re-infer a relation that exists as a real FK', () => {
  const rels = inferRelations({
    columns: [pk('students'), col('attendance', 'student_id')],
    fks: [{ tbl: 'attendance', col: 'student_id', refTable: 'students', refCol: 'id' }],
  });
  assert.deepEqual(rels, []);
});

test('does not infer when no candidate table exists or for plain id columns', () => {
  const rels = inferRelations({
    columns: [pk('students'), col('students', 'external_id'), col('students', 'id2')],
    fks: [],
  });
  assert.deepEqual(rels, []);
});

// ---------- compactColumn ----------

test('compactColumn renders pk + auto_increment', () => {
  assert.equal(
    compactColumn(pk('t', 'id', { type: 'int unsigned' })),
    'id int unsigned pk ai',
  );
});

test('compactColumn renders nn, default, and comment', () => {
  assert.equal(
    compactColumn(col('t', 'status', { type: "enum('active','archived')", nullable: 'NO', defaultValue: 'active', comment: 'soft delete flag' })),
    "status enum('active','archived') nn =active // soft delete flag",
  );
});

test('compactColumn renders unique and index flags', () => {
  assert.equal(compactColumn(col('t', 'email', { type: 'varchar(190)', keyKind: 'UNI' })), 'email varchar(190) uniq');
  assert.equal(compactColumn(col('t', 'dept', { keyKind: 'MUL' })), 'dept int idx');
});

test('compactColumn renders a real FK as an arrow and an inferred one with ?', () => {
  assert.equal(
    compactColumn(col('t', 'student_id'), { refTable: 'students', refCol: 'id', kind: 'fk' }),
    'student_id int -> students.id',
  );
  assert.equal(
    compactColumn(col('t', 'student_id'), { refTable: 'students', refCol: 'id', kind: 'inferred' }),
    'student_id int -> students.id?',
  );
});

// ---------- buildContext ----------

test('buildContext assembles tables, counts, and prefix groups', () => {
  const ctx = buildContext({
    server: 'S', db: 'D',
    tables: [
      { name: 'students', rowsApprox: 5230, comment: '' },
      { name: 'exam_results', rowsApprox: 100, comment: '' },
      { name: 'exam_rules', rowsApprox: 10, comment: 'grading config' },
      { name: 'exam_slots', rowsApprox: 20, comment: '' },
    ],
    columns: [
      pk('students'),
      col('students', 'name', { type: 'varchar(120)', nullable: 'NO' }),
      pk('exam_results'),
      col('exam_results', 'student_id'),
      pk('exam_rules'),
      pk('exam_slots'),
    ],
    fks: [],
  });

  assert.equal(ctx.server, 'S');
  assert.equal(ctx.db, 'D');
  assert.equal(ctx.tableCount, 4);
  assert.equal(ctx.columnCount, 6);
  assert.deepEqual(ctx.groups, { exam: ['exam_results', 'exam_rules', 'exam_slots'] });
  assert.deepEqual(ctx.tables.students, {
    rows: 5230,
    columns: ['id int pk ai', 'name varchar(120) nn'],
  });
  // inferred relation shows up inline on the column
  assert.deepEqual(ctx.tables.exam_results.columns, ['id int pk ai', 'student_id int -> students.id?']);
  // table comment is carried over
  assert.equal(ctx.tables.exam_rules.comment, 'grading config');
  // a note explains that ? arrows are guesses
  assert.ok(ctx.notes.some((n) => /inferred/i.test(n)));
});
