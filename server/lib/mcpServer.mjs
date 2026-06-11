/**
 * Minimal, transport-agnostic MCP server core (Model Context Protocol, spec
 * 2025-11-25). Pure and I/O-free: `handleMessage(jsonRpcMessage)` returns the
 * response object to send back, or null for notifications / no-reply messages.
 * A transport (see server/mcp.mjs for stdio) handles framing.
 *
 * Implements just the `tools` capability — exactly what lwdb needs to expose
 * its read/query surface to any MCP client (Claude Desktop, Cursor, …).
 */

export const JSONRPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

// Protocol versions we can speak, newest first. We echo the client's requested
// version when we support it, else fall back to our latest.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

function ok(id, result) { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * @param {object} opts
 * @param {{name: string, version: string, title?: string}} opts.serverInfo
 * @param {Array<{name, description, inputSchema, handler}>} opts.tools
 *   handler(args) -> any. Return value is JSON-encoded into a text content block.
 *   Throwing yields an isError result; if the error has a `.code`, it's surfaced
 *   as a stable {error:{code,message}} payload (matching the CLI/HTTP contract).
 */
export function createMcpServer({ serverInfo, tools = [] }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function callTool(id, params) {
    const tool = byName.get(params?.name);
    if (!tool) return err(id, JSONRPC.INVALID_PARAMS, `Unknown tool: ${params?.name}`);
    try {
      const result = await tool.handler(params.arguments || {});
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return ok(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      const text = e?.code
        ? JSON.stringify({ error: { code: e.code, message: e.message } })
        : String(e?.message || e);
      return ok(id, { content: [{ type: 'text', text }], isError: true });
    }
  }

  async function handleMessage(msg) {
    const isNotification = !msg || !('id' in msg);
    const { id, method, params } = msg || {};

    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params?.protocolVersion)
            ? params.protocolVersion
            : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        });

      case 'notifications/initialized':
        return null;

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.title ? { title: t.title } : {}),
          })),
        });

      case 'tools/call':
        return callTool(id, params);

      default:
        // Unknown notifications are silently ignored; unknown requests get -32601.
        return isNotification ? null : err(id, JSONRPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  return { handleMessage, tools };
}
