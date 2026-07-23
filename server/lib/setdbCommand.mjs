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

  // --status: show the current target AND a live connection health check.
  if (flags.status) {
    let text;
    try { text = await readFile(outPath, 'utf8'); } catch { return die(`no active target at ${outPath}`); }
    const parsed = parseActiveDb(text);
    const out = { path: outPath, ...parsed };
    if (parsed.server && !flags['no-check']) {
      try { out.connection = await backend.testConnection({ id: parsed.server }); }
      catch (e) { out.connection = { ok: false, error: e.message }; }
    }
    if (wantJson) return emit(out);
    process.stdout.write(`db:      ${parsed.dbName}\ncollege: ${parsed.collegeCode}\nserver:  ${parsed.server || '(unknown)'}  (${parsed.host})\n`);
    if (out.connection) {
      process.stdout.write(`status:  ${out.connection.ok ? `● connected (${out.connection.ms}ms)` : `○ DOWN — ${out.connection.error}`}\n`);
    }
    return;
  }

  const group = found.config.group;
  // ponytail: 'local' always searched too — localhost dev dbs live outside the project's server group
  const servers = (await backend.listServers()).filter((s) => !group || s.group === group || s.group === 'local');
  const isServer = (id) => { try { return !!registry.getConnection(id); } catch { return false; } };

  // Issue mode: `setdb <issue#>` — pure digits can't be a db name (dbs are like test_lcss64).
  if (positional[0] && /^\d+$/.test(positional[0]) && !positional[1]) {
    const { fetchIssueForSetdb } = await import('./setdbIssue.mjs');
    let resolved;
    try { resolved = fetchIssueForSetdb(positional[0]); }
    catch (e) { return die(`issue ${positional[0]}: ${e.message}`); }
    if (!resolved.dbName) {
      return die(`issue ${positional[0]} has no "Database and CHT Instance" line (college: ${resolved.college ?? 'unknown'}). Run: lwdb setdb <db> ${resolved.college ?? '<college>'}`);
    }
    // Feed the existing search-all-servers flow: db name + college override.
    positional = [resolved.dbName, ...(resolved.college ? [resolved.college] : [])];
  }

  // Resolve which server + db to set, from the args or interactively.
  let serverId = null;
  let dbName = null;
  let collegeArg = flags.code || null;
  const a0 = positional[0];
  let foundBySearch = false;

  if (a0 && isServer(a0)) {
    // Explicit: setdb <server> [db] [college]
    serverId = a0; dbName = positional[1] || null; collegeArg = collegeArg || positional[2] || null;
  } else if (a0) {
    // "connect <dbname>": a0 is not a server id → treat as a db name and find
    // which server hosts it. setdb <db> [college].
    dbName = a0; collegeArg = collegeArg || positional[1] || null;
    if (!wantJson) process.stdout.write(`Searching for '${dbName}' across ${servers.length} ${group || ''} server(s)…\n`);
    const hits = [];
    for (const s of servers) {
      try { if ((await backend.listDatabases(s.id)).includes(dbName)) hits.push(s.id); }
      catch { /* unreachable server — skip */ }
    }
    if (!hits.length) return die(`db '${dbName}' not found on any reachable ${group || ''} server`);
    foundBySearch = true;
    if (hits.length === 1) { serverId = hits[0]; if (!wantJson) process.stdout.write(`Found on ${serverId}.\n`); }
    else if (wantJson) return die(`db '${dbName}' found on multiple servers: ${hits.join(', ')} — run: setdb <server> ${dbName}`);
    else {
      process.stdout.write(`Found on ${hits.length} servers:\n`);
      hits.forEach((h, i) => process.stdout.write(`  ${i + 1}. ${h}\n`));
      const pick = await ask('Pick server: ');
      serverId = hits[Number(pick) - 1] || hits[0];
    }
  } else {
    // No args → interactive server pick.
    if (wantJson) return die('usage: setdb <server> <db> [college]  |  setdb <db>  (search across servers)');
    servers.forEach((s, i) => process.stdout.write(`  ${i + 1}. ${s.id}  (${s.host})\n`));
    const pick = await ask('Select server: ');
    serverId = servers[Number(pick) - 1]?.id || pick;
  }

  let conn;
  try { conn = registry.getConnection(serverId); } catch { conn = null; }
  if (!conn) return die(`unknown server '${serverId}'`);

  // db still missing (explicit-server or interactive without db) → list & pick.
  if (!dbName && !wantJson) {
    let dbs = [];
    try { dbs = await backend.listDatabases(serverId); } catch { /* offline */ }
    if (dbs.length) {
      const filter = (await ask(`Filter ${dbs.length} dbs on ${serverId} (enter = all): `)).toLowerCase();
      const shown = filter ? dbs.filter((d) => d.toLowerCase().includes(filter)) : dbs;
      shown.slice(0, 50).forEach((d, i) => process.stdout.write(`  ${i + 1}. ${d}\n`));
      if (shown.length > 50) process.stdout.write(`  … and ${shown.length - 50} more (narrow with a filter)\n`);
      const pick = await ask('Select db (number, or type a name): ');
      dbName = /^\d+$/.test(pick) ? (shown[Number(pick) - 1] || '') : pick;
    } else {
      dbName = await ask('Enter db name: ');
    }
  }
  if (!dbName) return die('empty db name');

  // Verify the db exists on the server (skip if search already proved it).
  if (found.config.verify && !flags['no-verify'] && !foundBySearch) {
    try {
      const dbs = await backend.listDatabases(serverId);
      if (!dbs.includes(dbName)) {
        if (wantJson) return die(`db '${dbName}' not found on ${serverId}`);
        const go = await ask(`db '${dbName}' not found on ${serverId}. Continue anyway? [y/N] `);
        if (go.toLowerCase() !== 'y') return die('aborted');
      }
    } catch { /* offline / no daemon: skip verification */ }
  }

  // Ensure the connection is actually alive before setting it.
  if (!flags['no-verify']) {
    try {
      const h = await backend.testConnection({ id: serverId });
      if (!wantJson && h?.ok) process.stdout.write(`Connection OK (${h.ms}ms).\n`);
    } catch (e) { return die(`connection to ${serverId} failed: ${e.message}`); }
  }

  const map = await loadCollegeMap();
  let code = resolveCollegeCode({ override: collegeArg, dbName, map });
  if (!code && !wantJson) code = (await ask('College code [TEST_DBNAME]: ')).toUpperCase();
  if (!code) code = 'TEST_DBNAME';

  const text = renderActiveDb({
    dbName, collegeCode: code, host: conn.host, port: conn.port, user: conn.user, password: conn.password, server: serverId,
  });
  if (flags.print) return emit(text);
  await writeTarget(outPath, text);
  emit({ ok: true, server: serverId, db: dbName, college: code, path: outPath });
}
