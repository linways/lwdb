import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const HOST_RE = /\$(?:AMS_AUTONOMOUS_)?DB_HOST\s*=.*?=\s*"([^"]+)"/;
const USER_RE = /\$(?:AMS_AUTONOMOUS_)?DB_USER\s*=.*?=\s*"([^"]+)"/;
const PASS_RE = /\$(?:AMS_AUTONOMOUS_)?DB_PASSWD\s*=.*?=\s*"([^"]+)"/;

function parseConfText(text) {
  const hostMatch = text.match(HOST_RE);
  const userMatch = text.match(USER_RE);
  const passMatch = text.match(PASS_RE);
  if (!hostMatch || !userMatch || !passMatch) return null;

  const raw = hostMatch[1];
  let host = raw;
  let port = 3306;
  if (raw.includes(':')) {
    const [h, p] = raw.split(':');
    host = h;
    port = parseInt(p, 10) || 3306;
  }

  return {
    host,
    port,
    user: userMatch[1],
    password: passMatch[1],
  };
}

export async function loadConnections(dbConfsDir) {
  const entries = await readdir(dbConfsDir);
  const txtFiles = entries.filter((f) => f.endsWith('.txt'));

  const connections = [];
  for (const file of txtFiles) {
    const full = join(dbConfsDir, file);
    const text = await readFile(full, 'utf8');
    const conf = parseConfText(text);
    if (!conf) continue;
    const id = basename(file, '.txt');
    connections.push({
      id,
      label: id === 'localdb' ? 'Local DB' : id,
      kind: id === 'localdb' ? 'local' : 'remote',
      ...conf,
    });
  }

  connections.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return connections;
}

export function safeConnection(conn) {
  const { password, ...rest } = conn;
  return { ...rest, hasPassword: !!password };
}
