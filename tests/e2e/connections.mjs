/**
 * Connection manager round-trip via the API (UI is exercised by the same
 * endpoints the manager calls). Verifies: create → list reflects it →
 * import upserts → export round-trips → delete.
 */
const BASE = process.env.BASE || 'http://127.0.0.1:4321';

async function j(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data?.error?.message || ''}`);
  return data;
}

let ok = true;
function check(cond, msg) { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) ok = false; }

// create
const created = await j('/api/connections', { method: 'POST', body: { label: 'E2E Temp', host: 'localhost', user: 'root', password: '', color: '#abc', group: 'e2e' } });
const id = created.connection.id;
check(id === 'e2e-temp', `created id is slug (${id})`);
check(created.connection.kind === 'local', 'localhost → local');
check(created.connection.password === undefined, 'list payload has no password');

// list reflects it
const list = await j('/api/connections');
check(list.connections.some((c) => c.id === id), 'list contains new connection');

// import upserts (idempotent)
const imp = await j('/api/connections/import', { method: 'POST', body: { version: 1, connections: [{ id, label: 'E2E Temp', host: 'localhost', user: 'root', password: '' }] } });
check(imp.result[0].status === 'updated', 'import upserts existing by id');

// export includes it (with password field)
const exp = await j('/api/connections/export');
check(exp.version === 1 && exp.connections.some((c) => c.id === id && 'password' in c), 'export round-trips with password');

// delete (cleanup)
const del = await j(`/api/connections/${id}`, { method: 'DELETE' });
check(del.ok === true, 'delete returns ok');
const after = await j('/api/connections');
check(!after.connections.some((c) => c.id === id), 'connection gone after delete');

console.log(ok ? '\n✓ ALL PASS' : '\n✗ FAIL');
process.exit(ok ? 0 : 1);
