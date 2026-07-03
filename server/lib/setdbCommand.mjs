import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { renderActiveDb, parseActiveDb, resolveCollegeCode } from './setdbTarget.mjs';
import { findSetdbConfig, loadCollegeMap } from './setdbConfig.mjs';

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

// helpers passed from bin: { registry, backend, flags, positional, wantJson, emit, die }
export async function runSetdb({ registry, backend, flags, positional, wantJson, emit, die }) {
  const found = await findSetdbConfig(process.cwd());
  if (!found) return die('no .setdb.json found in this directory or any parent');
  const outPath = join(found.root, found.config.output);

  if (flags.status) {
    let text;
    try { text = await readFile(outPath, 'utf8'); } catch { return die(`no active target at ${outPath}`); }
    return emit({ path: outPath, ...parseActiveDb(text) });
  }

  const group = found.config.group;
  const inGroup = (await backend.listServers()).filter((s) => !group || s.group === group);

  let serverId = positional[0];
  if (!serverId) {
    if (wantJson) return die('usage: setdb <server> <db> [college]');
    inGroup.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s.id}  (${s.host})\n`));
    const pick = await ask('Select server: ');
    serverId = inGroup[Number(pick) - 1]?.id || pick;
  }
  let conn;
  try { conn = registry.getConnection(serverId); } catch { conn = null; }
  if (!conn) return die(`unknown server '${serverId}'`);

  let dbName = positional[1];
  if (!dbName && !wantJson) dbName = await ask('Enter db name: ');
  if (!dbName) return die('empty db name');

  if (found.config.verify && !flags['no-verify']) {
    try {
      const dbs = await backend.listDatabases(serverId);
      if (!dbs.includes(dbName)) {
        if (wantJson) return die(`db '${dbName}' not found on ${serverId}`);
        const go = await ask(`db '${dbName}' not found on ${serverId}. Continue anyway? [y/N] `);
        if (go.toLowerCase() !== 'y') return die('aborted');
      }
    } catch { /* offline / no daemon: skip verification */ }
  }

  const map = await loadCollegeMap();
  let code = resolveCollegeCode({ override: flags.code || positional[2], dbName, map });
  if (!code && !wantJson) code = (await ask('College code [TEST_DBNAME]: ')).toUpperCase();
  if (!code) code = 'TEST_DBNAME';

  const text = renderActiveDb({
    dbName, collegeCode: code, host: conn.host, port: conn.port, user: conn.user, password: conn.password,
  });
  if (flags.print) return emit(text);
  await writeFile(outPath, text, 'utf8');
  emit({ ok: true, server: serverId, db: dbName, college: code, path: outPath });
}
