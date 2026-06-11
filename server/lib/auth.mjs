/**
 * Optional API token auth. Off by default (no token configured → every request
 * is allowed, the localhost-only model). When LW_DB_TOKEN is set, the HTTP API
 * requires it — for the rare case of binding the server beyond 127.0.0.1.
 *
 * A token may be presented as `Authorization: Bearer <token>` (CLI/daemon/MCP,
 * and the SPA after first load) or as a `?token=<token>` query param (so a
 * browser can do the very first page load via a URL).
 */
export function presentedToken(req = {}) {
  const headers = req.headers || {};
  const auth = headers.authorization || headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const query = req.query || {};
  if (query.token) return String(query.token);
  return null;
}

/** True if the request may proceed: no token configured, or it matches. */
export function isAuthorized(req, configuredToken) {
  if (!configuredToken) return true; // auth disabled
  return presentedToken(req) === configuredToken;
}
