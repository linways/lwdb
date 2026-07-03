import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';

const DEFAULTS = { group: 'linways', output: 'active-db.php', verify: true, includeInto: [] };

// lwdb's user-home (holds key/launcher/skill). Everything setdb needs lives here,
// so the tool works from any cwd and nothing app-specific leaks into the repo.
function lwdbHome() {
  return process.env.LWDB_HOME || join(homedir(), '.lwdb');
}

export async function findSetdbConfig(startDir) {
  // 1. optional repo override: walk up for a committed .setdb.json
  let dir = resolve(startDir);
  for (;;) {
    try {
      const raw = await readFile(join(dir, '.setdb.json'), 'utf8');
      return { config: { ...DEFAULTS, ...JSON.parse(raw) }, root: dir };
    } catch { /* not here — keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2. home config: ~/.lwdb/setdb.json (output is expected absolute here)
  try {
    const home = lwdbHome();
    const raw = await readFile(join(home, 'setdb.json'), 'utf8');
    return { config: { ...DEFAULTS, ...JSON.parse(raw) }, root: home };
  } catch { /* none */ }
  return null;
}

// Absolute output path wins as-is; a bare name resolves against the config's dir.
export function resolveOutput(config, root) {
  return isAbsolute(config.output) ? config.output : join(root, config.output);
}

export async function loadCollegeMap() {
  const candidates = [
    join(lwdbHome(), 'college-codes.json'),
    join(homedir(), '.config', 'linways', 'college-codes.json'), // legacy fallback
  ];
  for (const p of candidates) {
    try { return JSON.parse(await readFile(p, 'utf8')); } catch { /* try next */ }
  }
  return {};
}
