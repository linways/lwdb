#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
/**
 * One-shot migration: convert legacy Linways dbconfs/*.txt files into the
 * universal lwdb connection JSON. Run once, then `lwdb import <out>`.
 *
 * Usage: node tools/dbconfs-to-json.mjs <dbconfsDir> [outFile]
 *   default outFile: data/connections.import.json (gitignored)
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';

const HOST_RE = /\$(?:AMS_AUTONOMOUS_)?DB_HOST\s*=.*?=\s*"([^"]+)"/;
const USER_RE = /\$(?:AMS_AUTONOMOUS_)?DB_USER\s*=.*?=\s*"([^"]+)"/;
const PASS_RE = /\$(?:AMS_AUTONOMOUS_)?DB_PASSWD\s*=.*?=\s*"([^"]+)"/;

function parseConfText(text) {
  const h = text.match(HOST_RE), u = text.match(USER_RE), p = text.match(PASS_RE);
  if (!h || !u || !p) return null;
  let host = h[1], port = 3306;
  if (host.includes(':')) { const [hh, pp] = host.split(':'); host = hh; port = parseInt(pp, 10) || 3306; }
  return { host, port, user: u[1], password: p[1] };
}

const [dir, outArg] = process.argv.slice(2);
if (!dir) { console.error('usage: node tools/dbconfs-to-json.mjs <dbconfsDir> [outFile]'); process.exit(1); }
const out = outArg || join('data', 'connections.import.json');

const entries = (await readdir(dir)).filter((f) => f.endsWith('.txt'));
const connections = [];
for (const file of entries) {
  const conf = parseConfText(await readFile(join(dir, file), 'utf8'));
  if (!conf) { console.error(`skip (no creds): ${file}`); continue; }
  const id = basename(file, '.txt');
  connections.push({
    id,
    label: id === 'localdb' ? 'Local DB' : id,
    host: conf.host,
    port: conf.port,
    user: conf.user,
    password: conf.password,
    group: id === 'localdb' ? 'local' : 'linways',
  });
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ version: 1, connections }, null, 2) + '\n', 'utf8');
console.error(`wrote ${connections.length} connection(s) → ${out}`);
