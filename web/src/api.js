const base = '/api';
const TOKEN_KEY = 'lwdb:token';

// Optional API token. When the server runs with LW_DB_TOKEN, the first page load
// carries it as `?token=...`; capture it, persist it, and strip it from the URL.
// Subsequent /api calls send it as a Bearer header. No token → no-op (the default).
try {
  const u = new URL(window.location.href);
  const t = u.searchParams.get('token');
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    u.searchParams.delete('token');
    window.history.replaceState({}, '', u.pathname + u.search + u.hash);
  }
} catch { /* not a browser context */ }

function authHeader() {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    return t ? { authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function req(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...authHeader(), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || res.statusText);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  servers: () => req('/servers'),
  databases: (server) => req(`/servers/${encodeURIComponent(server)}/databases`),
  tables: (server, db) => req(`/servers/${encodeURIComponent(server)}/databases/${encodeURIComponent(db)}/tables`),
  describeTable: (server, db, table) => req(`/servers/${encodeURIComponent(server)}/databases/${encodeURIComponent(db)}/tables/${encodeURIComponent(table)}`),
  schema: (server, db) => req(`/servers/${encodeURIComponent(server)}/databases/${encodeURIComponent(db)}/schema`),
  query: (body) => req('/query', { method: 'POST', body }),
  snippets: () => req('/snippets'),
  createSnippet: (body) => req('/snippets', { method: 'POST', body }),
  updateSnippet: (id, body) => req(`/snippets/${id}`, { method: 'PUT', body }),
  deleteSnippet: (id) => req(`/snippets/${id}`, { method: 'DELETE' }),
  runSnippet: (id, body) => req(`/snippets/${id}/run`, { method: 'POST', body }),
  connections: () => req('/connections'),
  createConnection: (body) => req('/connections', { method: 'POST', body }),
  updateConnection: (id, body) => req(`/connections/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteConnection: (id) => req(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testConnection: (body) => req('/connections/test', { method: 'POST', body }),
  importConnections: (doc) => req('/connections/import', { method: 'POST', body: doc }),
  exportConnections: () => req('/connections/export'),
  approvals: () => req('/approvals'),
  resolveApproval: (id, decision) => req(`/approvals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: { decision } }),
};
