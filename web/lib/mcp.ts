/**
 * `/api/mcp`: the site's data as a Model Context Protocol server, so a reader
 * can add FatCat Watch to their own assistant (Claude, ChatGPT, Gemini CLI,
 * any MCP client) and ask about the data on their own subscription. The
 * tools are the reader chat's (`data-tools.ts`), so the two cannot answer
 * differently; results are the `/api/v1` bodies, `meta.caveats` included,
 * exactly as the public API returns them.
 *
 * Streamable HTTP, stateless: every request is one JSON-RPC message (or a
 * batch) POSTed and answered with JSON. No session, no server-to-client
 * stream (GET is a 405, as the transport allows), no auth — the data is the
 * public API's. Pure: the route only parses and serialises.
 */

import { CAVEATS, SITE_NAME } from "./methodology";
import { dataTools, fitToChars, type DataTool, type ToolContext } from "./data-tools";

/** Newest first; a client asking for one of these gets it back, anything else gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_SERVER_VERSION = "1.0.0";
/** Rows a list returns by default, and at most: an assistant's context is the reader's to spend. */
export const MCP_ROWS = { defaultRows: 25, maxRows: 100 } as const;
const MAX_RESULT_CHARS = 80_000;

type JsonRpcId = string | number | null;
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** What the server tells the assistant once, at `initialize`: how to use the tools and quote the data. */
export const MCP_INSTRUCTIONS = [
  `${SITE_NAME}: US congressional (STOCK Act) and corporate-insider (SEC Form 4) stock trades, reproduced as filed.`,
  "Use search_site first to turn a name into a bioguide_id or a company into its ticker. Link pages with the `url` fields in results; do not build URLs.",
  "Rules for quoting (every result repeats them in meta.caveats):",
  ...CAVEATS.map((c) => `- ${c}`),
].join("\n");

const TITLES: Record<string, string> = {
  search_site: "Search members, tickers and insider issuers",
  list_trades: "Congressional trades",
  list_members: "Members of Congress, ranked",
  get_member: "One member's record",
  list_tickers: "Tickers members traded, ranked",
  get_ticker: "One ticker's congressional record",
  get_insider_activity: "SEC Form 4 insider trades for one issuer",
  get_track_record: "Members' track record",
  get_coverage: "What the data covers",
};

function toolList(tools: DataTool[]) {
  return tools.map((t) => ({
    name: t.name,
    title: TITLES[t.name] ?? t.name,
    description: t.description,
    inputSchema: t.parameters,
    annotations: { title: TITLES[t.name] ?? t.name, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}

export type McpContext = { origin: string; tools?: DataTool[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * One JSON-RPC message → its response, or null when none is owed (a
 * notification, or a response to a request this server never makes).
 */
export async function handleMcpMessage(message: unknown, ctx: McpContext): Promise<JsonRpcResponse | null> {
  if (!isObject(message) || message.jsonrpc !== "2.0") return rpcError(null, INVALID_REQUEST, "not a JSON-RPC 2.0 message");
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  const id = hasId ? (message.id as string | number) : null;
  if (typeof message.method !== "string") {
    // A response or error from the client: nothing to answer.
    return "result" in message || "error" in message ? null : rpcError(id, INVALID_REQUEST, "method is required");
  }
  if (!hasId) return null; // notifications/initialized, notifications/cancelled, …

  const params = isObject(message.params) ? message.params : {};
  const tools = ctx.tools ?? dataTools(MCP_ROWS);
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fatcatwatch", title: SITE_NAME, version: MCP_SERVER_VERSION, websiteUrl: ctx.origin },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: toolList(tools) });
    case "tools/call": {
      const name = params.name;
      const args = params.arguments ?? {};
      if (typeof name !== "string") return rpcError(id, INVALID_PARAMS, "params.name is required");
      if (!isObject(args)) return rpcError(id, INVALID_PARAMS, "params.arguments must be an object");
      const tool = tools.find((t) => t.name === name);
      if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      const toolCtx: ToolContext = { origin: ctx.origin, ...MCP_ROWS };
      try {
        const out = await tool.run(args, toolCtx);
        const body = fitToChars(out.body, MAX_RESULT_CHARS);
        return ok({ content: [{ type: "text", text: JSON.stringify(body) }], isError: !out.ok });
      } catch {
        return rpcError(id, INTERNAL_ERROR, "the tool failed; try again");
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

/** A POSTed body: one message or a batch. `null` means 202 Accepted with no body. */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, INVALID_REQUEST, "empty batch");
    if (body.length > 20) return rpcError(null, INVALID_REQUEST, "batch too large");
    const out = (await Promise.all(body.map((m) => handleMcpMessage(m, ctx)))).filter((r): r is JsonRpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleMcpMessage(body, ctx);
}
