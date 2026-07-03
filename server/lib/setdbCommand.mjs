import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { renderActiveDb, parseActiveDb, resolveCollegeCode } from './setdbTarget.mjs';
import { findSetdbConfig, loadCollegeMap, resolveOutput } from './setdbConfig.mjs';

async function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

async function writeTarget(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

// helpers passed from bin: { registry, backend, flags, positional, wantJson, emit, die }
export async function runSetdb({ registry, backend, flags, positional, wantJson, emit, die }) {
  const found = await findSetdbConfig(process.cwd());
  if (!found) return die('no setdb config found — create ~/.lwdb/setdb.json (or a repo .setdb.json)');
  const outPath = resolveOutput(found.config, found.root);

  if (flags.init) {
    // Create the target file (placeholder if absent) and tell the user how to
    // wire it in. We do NOT edit conf files — the include must be pasted LAST.
    let existed = true;
    try { await readFile(outPath, 'utf8'); }
    catch { existed = false; await writeTarget(outPath, '<?php\n// setdb target — run: setdb <server> <db> [college]\n?>\n'); }
    // Absolute-path include — active-db.php can live anywhere (e.g. ~/.lwdb/dev/),
    // so the conf files reference it by full path, not a colocated basename.
    const line = `include "${outPath}";`;
    const targets = found.config.includeInto || [];
    if (wantJson) return emit({ path: outPath, created: !existed, include: line, addTo: targets, mustBeLast: true });
    process.stdout.write(`\nactive-db target ${existed ? 'exists' : 'created'} at:\n  ${outPath}\n\n`);
    process.stdout.write(`Add this line as the LAST db-config statement in each config file\n(else a later assignment overrides $DB_NAME/$HOST/etc.):\n\n  ${line}\n\n`);
    if (targets.length) { process.stdout.write('Paste into:\n'); targets.forEach((t) => process.stdout.write(`  ${t}\n`)); process.stdout.write('\n'); }
    return;
  }

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
  await writeTarget(outPath, text);
  emit({ ok: true, server: serverId, db: dbName, college: code, path: outPath });
}
