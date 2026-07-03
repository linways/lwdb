import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

const DEFAULTS = { group: 'linways', output: 'active-db.php', verify: true };

export async function findSetdbConfig(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    try {
      const raw = await readFile(join(dir, '.setdb.json'), 'utf8');
      return { config: { ...DEFAULTS, ...JSON.parse(raw) }, root: dir };
    } catch { /* not here — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadCollegeMap() {
  try {
    const p = join(homedir(), '.config', 'linways', 'college-codes.json');
    return JSON.parse(await readFile(p, 'utf8'));
  } catch { return {}; }
}
