// tests/setdbTarget.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderActiveDb, parseActiveDb, hostString, resolveCollegeCode } from '../server/lib/setdbTarget.mjs';

test('hostString embeds non-default port only', () => {
  assert.equal(hostString('139.59.44.63', 3306), '139.59.44.63');
  assert.equal(hostString('127.0.0.1', 3378), '127.0.0.1:3378');
});

test('renderActiveDb escapes only quote and backslash, passes $ % @', () => {
  const out = renderActiveDb({ dbName: 'db1', collegeCode: 'SJC', host: '127.0.0.1', port: 3378, user: 'merge', password: "a$b%c@d'e\\f" });
  assert.match(out, /\$DB_NAME = \$AMS_AUTONOMOUS_DB_NAME = 'db1';/);
  assert.match(out, /\$COLLEGE_CODE = 'SJC';/);
  assert.match(out, /\$HOST = \$DB_HOST = '127\.0\.0\.1:3378';/);
  assert.ok(out.includes("'a$b%c@d\\'e\\\\f'"));
});

test('parseActiveDb round-trips db and host', () => {
  const out = renderActiveDb({ dbName: 'mydb', collegeCode: 'X', host: 'h', port: 3306, user: 'u', password: 'p' });
  const p = parseActiveDb(out);
  assert.equal(p.dbName, 'mydb');
  assert.equal(p.host, 'h');
  assert.equal(p.server, null); // no server stamped
});

test('renderActiveDb stamps server id; parseActiveDb reads it back', () => {
  const out = renderActiveDb({ dbName: 'd', collegeCode: 'X', host: 'h', port: 3306, user: 'u', password: 'p', server: 'V3-server63' });
  assert.match(out, /^<\?php\n\/\/ setdb server=V3-server63\n/);
  assert.equal(parseActiveDb(out).server, 'V3-server63');
});

test('resolveCollegeCode precedence', () => {
  assert.equal(resolveCollegeCode({ override: 'sjc', dbName: 'x', map: {} }), 'SJC');
  assert.equal(resolveCollegeCode({ override: '', dbName: 'MES', map: { MES: 'DGMMES' } }), 'DGMMES');
  assert.equal(resolveCollegeCode({ override: '', dbName: 'unknown', map: {} }), null);
});
