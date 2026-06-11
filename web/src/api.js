const base = '/api';

async function req(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
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
