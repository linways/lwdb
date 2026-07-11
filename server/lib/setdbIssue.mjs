// setdbIssue.mjs — resolve a Redmine issue → { college, dbName } via the lwr CLI.
import { spawnSync } from 'node:child_process';

// The captured token must look like a real db (contain `_` or a digit, e.g.
// test_lcss64) so a bare header phrase like "Database and CHT Instance for
// LCSS" never captures a plain word such as "for".
const DB_LINE = /Database\s+and\s+CHT\s+Instance\s*(?:->|:|-)?\s*[`']?((?=\w*[_0-9])[A-Za-z][A-Za-z0-9_]+)/i;
const COLLEGE_CF_ID = 2;

/** Pure: lwr envelope → { college, dbName }. Throws on !ok envelopes. */
export function parseIssueForSetdb(envelope) {
  if (!envelope?.ok) {
    throw new Error(envelope?.error?.message || 'lwr returned a failure envelope');
  }
  const issue = envelope.data;
  const cf = (issue.custom_fields || []).find((c) => c.id === COLLEGE_CF_ID);
  const college = (cf?.value || '').trim() || null;
  const m = DB_LINE.exec(issue.description || '');
  return { college, dbName: m ? m[1] : null };
}

/** Shell `lwr issue view <id> --json`. Throws Error with a human message on any failure. */
export function fetchIssueForSetdb(issueId) {
  const r = spawnSync('lwr', ['issue', 'view', String(issueId), '--json'], {
    encoding: 'utf8', timeout: 30_000,
  });
  if (r.error?.code === 'ENOENT') throw new Error('lwr is not installed — issue mode needs the lw-redmine CLI');
  if (r.error) throw new Error(`lwr failed: ${r.error.message}`);
  let env;
  try { env = JSON.parse(r.stdout); } catch { throw new Error(`lwr returned non-JSON (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 200)}`); }
  return parseIssueForSetdb(env);
}
